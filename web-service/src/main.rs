#[tokio::main]
async fn main() {
    if let Err(error) = portviewer_web::run().await {
        eprintln!("PortViewer 运行失败：{error}");
        std::process::exit(2);
    }
}
