// Test-only executable. Never shipped. No real DPAPI/storage; proves timeout/exit are not retried.
use std::{io::{Read, Write}, path::PathBuf, time::Duration};
fn main() {
    std::panic::set_hook(Box::new(|_|{}));
    let dir=std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let counter:PathBuf=dir.join("counter");
    let old=std::fs::read(&counter).ok().filter(|v|v.len()==4).map(|v|u32::from_le_bytes(v.try_into().unwrap())).unwrap_or(0);
    std::fs::write(counter,(old+1).to_le_bytes()).unwrap();
    let mut input=Vec::new();std::io::stdin().take(8_500_004).read_to_end(&mut input).unwrap();
    for b in &mut input {unsafe{std::ptr::write_volatile(b,0);}}
    let mode=std::fs::read_to_string(dir.join("mode")).unwrap();
    match mode.as_str() {
        "timeout"=>std::thread::sleep(Duration::from_secs(30)),
        "oversize"=>{let out=vec![b'x';100_000];let _=std::io::stdout().write_all(&out);},
        "invalid"=>{let _=std::io::stdout().write_all(b"invalid-fixed-response");},
        _=>std::process::exit(71)
    }
}
