pub mod diagnostics;
#[path = "manager.rs"]
mod manager;
pub mod memory_sample;

pub fn run_manager() -> std::process::ExitCode {
    manager::main()
}
