use std::ffi::c_void;
use std::mem::{self, MaybeUninit};
use std::ptr;

use crate::error::{AppError, AppResult};

const INITIAL_BUFFER_SIZE: u32 = 16_384;
const MAX_BUFFER_SIZE: u32 = 64 * 1024 * 1024;
const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
const TABLE_HEADER_SIZE: usize = mem::size_of::<u32>();

/// Win32 table API 可直接写入且任意位模式均有效的 POD 行结构。
///
/// # Safety
///
/// 实现类型必须是 `repr(C)` 的纯数据结构，不含引用、布尔值或需要析构的字段；
/// 从 Win32 返回的完整行字节复制后必须构成有效值。
pub(super) unsafe trait TableRow: Copy {}

/// 调用 IP Helper 的可变长度 table API，并安全复制每一行。
///
/// 缓冲区使用 `u64` 作为后备存储以满足 Win32 结构对齐；行使用
/// 字节复制而非把任意字节切片借用为对齐结构，避免未对齐引用造成 UB。
pub(super) fn query_rows<T, F>(label: &str, mut query: F) -> AppResult<Vec<T>>
where
    T: TableRow,
    F: FnMut(*mut c_void, &mut u32) -> u32,
{
    let mut requested_size = INITIAL_BUFFER_SIZE;

    loop {
        let words = (requested_size as usize).div_ceil(mem::size_of::<u64>());
        let mut storage = vec![0_u64; words];
        let mut actual_size = (storage.len() * mem::size_of::<u64>()) as u32;
        let status = query(storage.as_mut_ptr().cast(), &mut actual_size);

        if status == ERROR_INSUFFICIENT_BUFFER {
            if actual_size <= requested_size {
                return Err(AppError::ScanError(format!(
                    "{label} 返回无效的缓冲区大小: {actual_size}"
                )));
            }
            if actual_size > MAX_BUFFER_SIZE {
                return Err(AppError::ScanError(format!(
                    "{label} 请求的缓冲区超过安全上限: {actual_size} 字节"
                )));
            }
            requested_size = actual_size;
            continue;
        }

        if status != 0 {
            return Err(AppError::ScanError(format!(
                "{label} 失败，Win32 错误码: {status}"
            )));
        }

        let valid_size = actual_size as usize;
        if valid_size > storage.len() * mem::size_of::<u64>() {
            return Err(AppError::ScanError(format!(
                "{label} 返回的数据长度超过已分配缓冲区"
            )));
        }

        let bytes =
            unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>(), valid_size) };
        return parse_rows(bytes, label);
    }
}

pub(super) fn parse_rows<T: TableRow>(bytes: &[u8], label: &str) -> AppResult<Vec<T>> {
    if bytes.len() < TABLE_HEADER_SIZE {
        return Err(AppError::ScanError(format!("{label} 表头不完整")));
    }

    let count = u32::from_ne_bytes(bytes[..TABLE_HEADER_SIZE].try_into().expect("固定长度"));
    let rows_size = (count as usize)
        .checked_mul(mem::size_of::<T>())
        .ok_or_else(|| AppError::ScanError(format!("{label} 条目数量溢出")))?;
    let expected_size = TABLE_HEADER_SIZE
        .checked_add(rows_size)
        .ok_or_else(|| AppError::ScanError(format!("{label} 数据大小溢出")))?;

    if bytes.len() < expected_size {
        return Err(AppError::ScanError(format!(
            "{label} 返回数据不完整：声明 {count} 条，实际 {} 字节",
            bytes.len()
        )));
    }

    let mut rows = Vec::with_capacity(count as usize);
    for index in 0..count as usize {
        let offset = TABLE_HEADER_SIZE + index * mem::size_of::<T>();
        let source = unsafe { bytes.as_ptr().add(offset) };
        let mut row = MaybeUninit::<T>::uninit();
        unsafe {
            ptr::copy_nonoverlapping(source, row.as_mut_ptr().cast::<u8>(), mem::size_of::<T>());
            rows.push(row.assume_init());
        }
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct TestRow {
        first: u32,
        second: u32,
    }

    unsafe impl TableRow for TestRow {}

    fn table_bytes(rows: &[TestRow]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(TABLE_HEADER_SIZE + mem::size_of_val(rows));
        bytes.extend_from_slice(&(rows.len() as u32).to_ne_bytes());
        let row_bytes = unsafe {
            std::slice::from_raw_parts(rows.as_ptr().cast::<u8>(), mem::size_of_val(rows))
        };
        bytes.extend_from_slice(row_bytes);
        bytes
    }

    #[test]
    fn parses_first_and_last_rows_without_offset_error() {
        let source = [
            TestRow {
                first: 1,
                second: 2,
            },
            TestRow {
                first: 3,
                second: 4,
            },
        ];
        let parsed = parse_rows::<TestRow>(&table_bytes(&source), "test").unwrap();
        assert_eq!(parsed, source);
    }

    #[test]
    fn accepts_an_empty_table() {
        assert!(parse_rows::<TestRow>(&0_u32.to_ne_bytes(), "test")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_truncated_header_and_rows() {
        assert!(parse_rows::<TestRow>(&[0, 0, 0], "test").is_err());

        let mut bytes = 1_u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(&[0; 4]);
        assert!(parse_rows::<TestRow>(&bytes, "test").is_err());
    }

    #[test]
    fn should_reject_a_huge_declared_count_without_allocating_rows() {
        let bytes = u32::MAX.to_ne_bytes();

        assert!(parse_rows::<TestRow>(&bytes, "test").is_err());
    }

    #[test]
    fn rejects_buffer_growth_above_safety_limit() {
        let mut calls = 0;
        let result = query_rows::<TestRow, _>("test", |_buffer, size| {
            calls += 1;
            *size = MAX_BUFFER_SIZE + 1;
            ERROR_INSUFFICIENT_BUFFER
        });

        assert!(matches!(result, Err(AppError::ScanError(_))));
        assert_eq!(calls, 1);
    }
}
