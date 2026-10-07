mod api;
mod auth;
mod client;
mod command;
mod formatting;
mod mcp;
mod platform;
mod ports;

use tracing_subscriber::EnvFilter;

pub async fn run() -> Result<(), String> {
    let command = command::Command::parse_environment_and_args()?;
    init_logging();

    match command {
        command::Command::Serve(config) => api::serve(config).await,
        command::Command::Check(config) => {
            let client = client::ApiClient::connect(&config.server).await?;
            let value = client
                .check_ports(&config.ports, config.protocol, config.details)
                .await?;
            println!("{}", formatting::format_check(&value, config.output)?);
            Ok(())
        }
        command::Command::Free(config) => {
            let client = client::ApiClient::connect(&config.server).await?;
            let value = client
                .find_free_port(config.protocol, config.start, config.end)
                .await?;
            println!("{}", formatting::format_free(&value, config.output)?);
            Ok(())
        }
        command::Command::Mcp(config) => {
            let client = client::ApiClient::connect(&config.server).await?;
            mcp::serve(client).await
        }
        command::Command::Help(text) => {
            println!("{text}");
            Ok(())
        }
    }
}

fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_target(false)
        .with_writer(std::io::stderr)
        .compact()
        .try_init();
}
