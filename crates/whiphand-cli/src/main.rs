fn main() {
    let code = whiphand_cli::main_with(std::env::args_os().collect());
    std::process::exit(code);
}
