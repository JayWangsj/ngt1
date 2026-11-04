#[path = "manager.rs"]
mod manager;

pub fn run_manager() -> std::process::ExitCode {
    manager::main()
}
