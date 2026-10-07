use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

#[derive(Debug)]
pub struct CommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
}

/// 运行只读探测命令。命令不经过 shell，并对时长和输出量设硬上限。
pub fn run_limited(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutput, String> {
    let program_label = program.display();
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {program_label}：{error}"))?;
    let stdout = child.stdout.take().ok_or("无法捕获命令标准输出")?;
    let stderr = child.stderr.take().ok_or("无法捕获命令错误输出")?;
    let stdout_reader = thread::spawn(move || read_capped(stdout));
    let stderr_reader = thread::spawn(move || read_capped(stderr));
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{program_label} 探测超时（{} ms）",
                    timeout.as_millis()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("等待 {program_label} 失败：{error}"));
            }
        }
    };

    let stdout = join_reader(stdout_reader, "标准输出")?;
    let stderr = join_reader(stderr_reader, "错误输出")?;
    Ok(CommandOutput {
        stdout,
        stderr,
        success: status.success(),
    })
}

fn read_capped<R: Read>(mut reader: R) -> io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut total = 0_usize;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read);
        if output.len() < OUTPUT_LIMIT {
            let remaining = OUTPUT_LIMIT - output.len();
            output.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }
    if total > OUTPUT_LIMIT {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("探测输出超过 {} MiB 上限", OUTPUT_LIMIT / 1024 / 1024),
        ))
    } else {
        Ok(output)
    }
}

fn join_reader(
    handle: thread::JoinHandle<io::Result<Vec<u8>>>,
    label: &str,
) -> Result<Vec<u8>, String> {
    handle
        .join()
        .map_err(|_| format!("读取{label}的线程异常结束"))?
        .map_err(|error| format!("读取{label}失败：{error}"))
}

pub fn utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_start_matches('\u{feff}')
        .trim()
        .to_string()
}
