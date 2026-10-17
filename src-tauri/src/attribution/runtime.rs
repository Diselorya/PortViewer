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
    let mut name = match (&npm_script, &project, &entry) {
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
    let declared = crate::knowledge::local::project(&tokens, false);
    if let Some(project) = &declared {
        if let Some(project_name) = &project.name {
            name = format!("Node.js: {project_name}");
        }
        facts.push(fact("项目路径", project.root.to_string_lossy()));
        facts.push(fact("配置路径", project.metadata.to_string_lossy()));
        facts.push(fact(
            "项目私有声明",
            if project.private {
                "是"
            } else {
                "未声明；不自动外传项目标识"
            },
        ));
        if project.description.is_some() {
            facts.push(fact("简介来源", "package.json description"));
        }
    }
    if let Some(launcher) = crate::knowledge::local::launcher(&tokens, false) {
        facts.push(fact("公开软件", launcher));
    }
    Some(ServiceAttribution {
        kind: AttributionKind::NodeApplication,
        name,
        description: declared.and_then(|project| project.description),
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
    let module = crate::knowledge::local::python_module(&tokens);
    let script = crate::knowledge::local::entrypoint(&tokens, true);
    let (mut name, confidence) = if let Some(module) = &module {
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
    let declared = crate::knowledge::local::project(&tokens, true);
    if let Some(project) = &declared {
        if let Some(project_name) = &project.name {
            name = format!("Python: {project_name}");
        }
        facts.push(fact("项目路径", project.root.to_string_lossy()));
        facts.push(fact("配置路径", project.metadata.to_string_lossy()));
        facts.push(fact("项目私有声明", "本机项目标识不自动外传"));
        if project.description.is_some() {
            facts.push(fact("简介来源", "pyproject.toml description"));
        }
    }
    if let Some(launcher) = crate::knowledge::local::launcher(&tokens, true) {
        facts.push(fact("公开软件", launcher));
    }
    Some(ServiceAttribution {
        kind: AttributionKind::PythonApplication,
        name,
        description: declared.and_then(|project| project.description),
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
    crate::knowledge::local::entrypoint(tokens, false).map(safe_path_summary)
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
    #[test]
    fn python_inline_code_and_module_arguments_are_not_script_entrypoints() {
        for (command, expected) in [
            ("python -c fake.py", "Python 应用"),
            ("python -m uvicorn app.py", "Python module: uvicorn"),
        ] {
            let result = classify(
                42,
                &snapshot(vec![ProcessRecord {
                    process_id: 42,
                    parent_process_id: 0,
                    name: Some("python.exe".into()),
                    executable_path: None,
                    command_line: Some(command.into()),
                    created_at: None,
                }]),
            );
            assert_eq!(result[0].name, expected);
            assert!(!result[0].facts.iter().any(|fact| fact.label == "入口"));
        }
    }
}
