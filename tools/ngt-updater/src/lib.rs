#[path = "manager.rs"]
mod manager;
pub mod diagnostics;

pub fn run_manager() -> std::process::ExitCode {
    manager::main()
}
