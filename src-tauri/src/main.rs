// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The same executable doubles as the sandboxed PDF worker process.
    if std::env::args().nth(1).as_deref() == Some(novapdf_lib::worker::WORKER_FLAG) {
        novapdf_lib::worker::main();
    }
    novapdf_lib::run()
}
