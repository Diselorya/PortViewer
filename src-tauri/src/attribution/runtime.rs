use std::path::Path;

use super::system::{fact, ProcessRecord, SystemSnapshot};
use crate::network::types::{AttributionConfidence, AttributionKind, ServiceAttribution};

pub fn classify(pid: u32, snapshot: &SystemSnapshot) -> Vec<ServiceAttribution> {
    let chain = snapshot.ancestors(pid);
    let Some(process) = chain.first() else {
        return Vec::new();
    };
    let name = process
        .name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if is_node(&name, process.command_line.as_deref()) {
        node_attribution(process, &chain).into_iter().collect()
    } else if is_python(&name, process.command_line.as_deref()) {
        python_attribution(process).into_iter().collect()
    } else {
        Vec::new()
    }
}

fn node_attribution(
    process: &ProcessRecord,
    chain: &[&ProcessRecord],
) -> Option<ServiceAttribution> {
    let tokens = tokenize(process.command_line.as_deref()?);
    let npm_script = chain.iter().find_map(|ancestor| {
        npm_script_from_command(ancestor.command_line.as_deref().unwrap_or_default())
    });
    let entry = node_entrypoint(&tokens);
    let project = tokens
        .iter()
        .find_map(|token| project_from_node_modules(token));
    let name = match (&npm_script, &project, &entry) {
        (Some(script), Some(project), _) => format!("npm: {script} · {project}"),
        (Some(script), None, _) => format!("npm: {script}"),
        (None, _, Some(entry)) => format!("Node.js: {entry}"),
        _ => "Node.js 应用".to_string(),
    };
    let mut facts = Vec::new();
    if let Some(script) = npm_script {
        facts.push(fact("npm script", script));
    }
    if let Some(project) = project {
        facts.push(fact("项目", project));
    }
    if let Some(entry) = entry {
        facts.push(fact("入口", entry));
    }
    Some(ServiceAttribution {
        kind: AttributionKind::NodeApplication,
        name,
        description: Some("Node.js/npm 临时运行工作负载".to_string()),
        confidence: if facts.is_empty() {
            AttributionConfidence::Medium
        } else {
            AttributionConfidence::High
        },
        source: "Win32_Process 命令行 + 父进程链（脱敏摘要）".to_string(),
        facts,
    })
}

fn python_attribution(process: &ProcessRecord) -> Option<ServiceAttribution> {
    let tokens = tokenize(process.command_line.as_deref()?);
    let module = tokens
        .windows(2)
        .find(|pair| pair[0] == "-m")
        .map(|pair| pair[1].clone());
    let script = tokens.iter().find(|token| {
        let lower = token.to_ascii_lowercase();
        lower.ends_with(".py") || lower.ends_with(".pyw")
    });
    let (name, confidence) = if let Some(module) = &module {
        (
            format!("Python module: {module}"),
            AttributionConfidence::High,
        )
    } else if let Some(script) = script {
        (
            format!("Python: {}", file_name(script)),
            AttributionConfidence::High,
        )
    } else {
        ("Python 应用".to_string(), AttributionConfidence::Medium)
    };
    let mut facts = Vec::new();
    if let Some(module) = module {
        facts.push(fact("模块", module));
    }
    if let Some(script) = script {
        facts.push(fact("入口", safe_path_summary(script)));
    }
    Some(ServiceAttribution {
        kind: AttributionKind::PythonApplication,
        name,
        description: Some("Python 临时运行工作负载".to_string()),
        confidence,
        source: "Win32_Process 命令行（脱敏摘要）".to_string(),
        facts,
    })
}

fn is_node(name: &str, command: Option<&str>) -> bool {
    name == "node.exe"
        || name == "node"
        || command.is_some_and(|value| value.to_ascii_lowercase().contains("node.exe"))
}

fn is_python(name: &str, command: Option<&str>) -> bool {
    name.starts_with("python")
        || name == "py.exe"
        || command.is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("python.exe") || value.contains("python3")
        })
}

fn npm_script_from_command(command: &str) -> Option<String> {
    let tokens = tokenize(command);
    let npm_position = tokens.iter().position(|token| {
        let token = token.to_ascii_lowercase();
        token.contains("npm-cli.js") || file_name(&token).starts_with("npm")
    })?;
    let tail = &tokens[npm_position + 1..];
    let run = tail
        .iter()
        .position(|token| token == "run" || token == "run-script")?;
    tail.get(run + 1)
        .filter(|value| !value.starts_with('-'))
        .map(|value| value.to_string())
}

fn node_entrypoint(tokens: &[String]) -> Option<String> {
    tokens
        .iter()
        .skip(1)
        .find(|token| {
            let lower = token.to_ascii_lowercase();
            [".js", ".mjs", ".cjs", ".ts", ".tsx"]
                .iter()
                .any(|extension| lower.ends_with(extension))
        })
        .map(|token| safe_path_summary(token))
}

fn project_from_node_modules(token: &str) -> Option<String> {
    let normalized = token.replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    let index = lower.find("\\node_modules\\")?;
    Path::new(&normalized[..index])
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn safe_path_summary(value: &str) -> String {
    let name = file_name(value);
    let parent = Path::new(value)
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str());
    match parent {
        Some(parent) if !parent.is_empty() => format!("{parent}\\{name}"),
        _ => name,
    }
}

fn file_name(value: &str) -> String {
    value
        .rsplit(['\\', '/'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(value)
        .to_string()
}

/// 足以识别入口文件和 npm script 的 Windows 命令行 tokenizer；不把原始命令行写入模型。
pub(crate) fn tokenize(value: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut quote = '\0';
    for character in value.chars() {
        if (character == '"' || character == '\'') && (!quoted || character == quote) {
            if quoted {
                quoted = false;
                quote = '\0';
            } else {
                quoted = true;
                quote = character;
            }
        } else if character.is_whitespace() && !quoted {
            if !current.is_empty() {
                result.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if !current.is_empty() {
        result.push(current);
    }
    result
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn snapshot(records: Vec<ProcessRecord>) -> SystemSnapshot {
        SystemSnapshot {
            processes: records
                .into_iter()
                .map(|record| (record.process_id, record))
                .collect::<HashMap<_, _>>(),
            services: Vec::new(),
            permission_limited_processes: 0,
            incomplete_processes: 0,
        }
    }

    #[test]
    fn identifies_npm_script_project_and_entry_without_exposing_arguments() {
        let result = classify(
            10,
            &snapshot(vec![
                ProcessRecord {
                    process_id: 10,
                    parent_process_id: 20,
                    name: Some("node.exe".to_string()),
                    executable_path: None,
                    command_line: Some(
                        r#"node C:\work\demo\node_modules\vite\bin\vite.js --token secret"#
                            .to_string(),
                    ),
                    created_at: None,
                },
                ProcessRecord {
                    process_id: 20,
                    parent_process_id: 0,
                    name: Some("node.exe".to_string()),
                    executable_path: None,
                    command_line: Some(
                        r#"node C:\node\npm-cli.js run dev -- --token secret"#.to_string(),
                    ),
                    created_at: None,
                },
            ]),
        );
        assert_eq!(result[0].name, "npm: dev · demo");
        assert!(!format!("{result:?}").contains("secret"));
    }

    #[test]
    fn identifies_python_module_and_script() {
        let module = ProcessRecord {
            process_id: 1,
            parent_process_id: 0,
            name: Some("python.exe".to_string()),
            executable_path: None,
            command_line: Some("python -m uvicorn api:app".to_string()),
            created_at: None,
        };
        assert_eq!(
            classify(1, &snapshot(vec![module]))[0].name,
            "Python module: uvicorn"
        );

        let script = ProcessRecord {
            process_id: 2,
            parent_process_id: 0,
            name: Some("python.exe".to_string()),
            executable_path: None,
            command_line: Some(r#"python "C:\work\api\server.py""#.to_string()),
            created_at: None,
        };
        assert_eq!(
            classify(2, &snapshot(vec![script]))[0].name,
            "Python: server.py"
        );
    }
}
