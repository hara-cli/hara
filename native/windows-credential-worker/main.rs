//! Hara-only, one-request CurrentUser DPAPI worker. No CLI/path/env supplied storage roots.
//! Build: rustc --edition=2021 -C opt-level=2 -C panic=abort -C strip=symbols main.rs
#![cfg_attr(not(windows), allow(dead_code, unused_imports))]
#[cfg(not(windows))]
fn main() { std::process::exit(70); }
#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, io::{Read, Write}, mem::{size_of, zeroed}, os::windows::ffi::OsStrExt,
        path::{Path, PathBuf}, ptr::{null, null_mut}, sync::atomic::{compiler_fence, Ordering}};
    type Handle = *mut c_void;
    type Result<T> = std::result::Result<T, u8>;
    const INVALID: u8 = 1; const UNAVAILABLE: u8 = 2; const ACCESS: u8 = 3;
    const UNREADABLE: u8 = 4; const WRITE_UNKNOWN: u8 = 5; const CLEANUP_UNKNOWN: u8 = 6;
    const MAX_FRAME: usize = 8_500_000;
    const MAX_CIPHER: usize = 131_072;
    const SERVICE: &[u8] = b"tech.nanhara.hara.workspace.credentials.v1\0DPAPI-CurrentUser-v1\0";
    const READ_CONTROL: u32 = 0x20000; const DELETE: u32 = 0x10000;
    const GENERIC_READ: u32 = 0x80000000; const GENERIC_WRITE: u32 = 0x40000000;
    const OPEN_REPARSE: u32 = 0x00200000; const BACKUP: u32 = 0x02000000;
    #[repr(C)] struct Blob { len: u32, data: *mut u8 }
    #[repr(C)] struct Sa { len: u32, sd: *mut c_void, inherit: i32 }
    #[repr(C)] struct Guid { a: u32, b: u16, c: u16, d: [u8;8] }
    #[repr(C)] #[derive(Default)] struct Info { attrs: u32, times: [u32;6], volume: u32, size_hi: u32, size_lo: u32, links: u32, index_hi: u32, index_lo: u32 }
    #[repr(C)] struct AclSize { count: u32, used: u32, free: u32 }
    #[repr(C)] struct AceHeader { kind: u8, flags: u8, size: u16 }
    #[link(name="kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(h: Handle) -> i32;
        fn LocalFree(p: *mut c_void) -> *mut c_void;
        fn CreateFileW(path: *const u16, access: u32, share: u32, sa: *const Sa, creation: u32, flags: u32, template: Handle) -> Handle;
        fn CreateDirectoryW(path: *const u16, sa: *const Sa) -> i32;
        fn GetFileInformationByHandle(h: Handle, info: *mut Info) -> i32;
        fn ReadFile(h: Handle, buf: *mut c_void, size: u32, read: *mut u32, overlapped: *mut c_void) -> i32;
        fn WriteFile(h: Handle, buf: *const c_void, size: u32, written: *mut u32, overlapped: *mut c_void) -> i32;
        fn FlushFileBuffers(h: Handle) -> i32;
        fn SetFileInformationByHandle(h: Handle, class: u32, data: *const c_void, size: u32) -> i32;
    }
    #[link(name="advapi32")]
    extern "system" {
        fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
        fn GetTokenInformation(token: Handle, class: u32, data: *mut c_void, len: u32, needed: *mut u32) -> i32;
        fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, sd: *mut *mut c_void, size: *mut u32) -> i32;
        fn GetSecurityInfo(h: Handle, kind: u32, flags: u32, owner: *mut *mut c_void, group: *mut *mut c_void, dacl: *mut *mut c_void, sacl: *mut *mut c_void, sd: *mut *mut c_void) -> u32;
        fn GetSecurityDescriptorControl(sd: *const c_void, control: *mut u16, revision: *mut u32) -> i32;
        fn GetAclInformation(acl: *const c_void, info: *mut c_void, len: u32, class: u32) -> i32;
        fn GetAce(acl: *const c_void, index: u32, ace: *mut *mut c_void) -> i32;
        fn EqualSid(a: *const c_void, b: *const c_void) -> i32;
    }
    #[link(name="crypt32")]
    extern "system" {
        fn CryptProtectData(input: *const Blob, description: *const u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
        fn CryptUnprotectData(input: *const Blob, description: *mut *mut u16, entropy: *const Blob, reserved: *mut c_void, prompt: *mut c_void, flags: u32, output: *mut Blob) -> i32;
    }
    #[link(name="shell32")]
    extern "system" { fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Handle, out: *mut *mut u16) -> i32; }
    #[link(name="ole32")]
    extern "system" { fn CoTaskMemFree(p: *mut c_void); }
    #[link(name="bcrypt")]
    extern "system" {
        fn BCryptOpenAlgorithmProvider(h: *mut Handle, name: *const u16, provider: *const u16, flags: u32) -> i32;
        fn BCryptCloseAlgorithmProvider(h: Handle, flags: u32) -> i32;
        fn BCryptHash(h: Handle, secret: *const u8, secret_len: u32, input: *const u8, input_len: u32, output: *mut u8, output_len: u32) -> i32;
        fn BCryptGenRandom(h: Handle, output: *mut u8, len: u32, flags: u32) -> i32;
    }
    fn wipe(buf: &mut [u8]) { for b in buf { unsafe { std::ptr::write_volatile(b, 0); } } compiler_fence(Ordering::SeqCst); }
    struct Secret(Vec<u8>);
    impl Drop for Secret { fn drop(&mut self) { wipe(&mut self.0); } }
    struct Owned(Handle);
    impl Drop for Owned { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
    struct Local(*mut c_void);
    impl Drop for Local { fn drop(&mut self) { unsafe { LocalFree(self.0); } } }
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> { s.encode_wide().chain(Some(0)).collect() }
    fn wstr(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    fn os_error() -> u8 { if unsafe { GetLastError() } == 5 { ACCESS } else { UNAVAILABLE } }
    fn hex(v: &[u8]) -> String { v.iter().map(|b| format!("{b:02x}")).collect() }
    fn hash(v: &[u8]) -> Result<[u8;32]> {
        let mut h = null_mut(); let mut out=[0;32];
        unsafe {
            if BCryptOpenAlgorithmProvider(&mut h, wstr("SHA256").as_ptr(), null(), 0) < 0 { return Err(UNAVAILABLE); }
            let rc=BCryptHash(h, null(), 0, v.as_ptr(), v.len() as u32, out.as_mut_ptr(), 32);
            BCryptCloseAlgorithmProvider(h,0); if rc < 0 { return Err(UNAVAILABLE); }
        } Ok(out)
    }
    struct Security { _token: Owned, _token_bytes: Vec<usize>, sid: *const c_void, _sd: Local }
    impl Security {
        fn new() -> Result<Self> { unsafe {
            let mut token=null_mut();
            if OpenProcessToken(GetCurrentProcess(),8,&mut token)==0 { return Err(os_error()); }
            let token=Owned(token); let mut needed=0;
            GetTokenInformation(token.0,1,null_mut(),0,&mut needed);
            if needed==0 || needed>65536 { return Err(UNAVAILABLE); }
            // usize allocation guarantees TOKEN_USER and SID alignment.
            let mut bytes=vec![0usize;(needed as usize+size_of::<usize>()-1)/size_of::<usize>()];
            if GetTokenInformation(token.0,1,bytes.as_mut_ptr().cast(),needed,&mut needed)==0 { return Err(os_error()); }
            let sid=*(bytes.as_ptr().cast::<*const c_void>()); let mut text=null_mut();
            if ConvertSidToStringSidW(sid,&mut text)==0 { return Err(os_error()); }
            let text_mem=Local(text.cast()); let mut n=0; while *text.add(n)!=0 && n<1024 { n+=1; }
            let sid_text=String::from_utf16(std::slice::from_raw_parts(text,n)).map_err(|_|UNAVAILABLE)?;
            let sddl=wstr(&format!("O:{sid_text}D:P(A;OICI;FA;;;{sid_text})")); let mut sd=null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(),1,&mut sd,null_mut())==0 { return Err(os_error()); }
            drop(text_mem); Ok(Self{_token:token,_token_bytes:bytes,sid,_sd:Local(sd)})
        } }
        fn sa(&self) -> Sa { Sa{len:size_of::<Sa>() as u32,sd:self._sd.0,inherit:0} }
        fn check(&self, h: Handle) -> Result<()> { unsafe {
            let mut owner=null_mut(); let mut dacl=null_mut(); let mut sd=null_mut();
            if GetSecurityInfo(h,1,5,&mut owner,null_mut(),&mut dacl,null_mut(),&mut sd)!=0 { return Err(ACCESS); }
            let _sd=Local(sd); let mut control=0; let mut revision=0;
            if owner.is_null() || EqualSid(owner,self.sid)==0 || dacl.is_null()
                || GetSecurityDescriptorControl(sd,&mut control,&mut revision)==0 || control&0x1004!=0x1004 { return Err(ACCESS); }
            let mut ai: AclSize=zeroed();
            if GetAclInformation(dacl,(&mut ai as *mut AclSize).cast(),size_of::<AclSize>() as u32,2)==0 || ai.count!=1 { return Err(ACCESS); }
            let mut ace=null_mut();
            if GetAce(dacl,0,&mut ace)==0 { return Err(ACCESS); }
            let header=&*(ace.cast::<AceHeader>());
            if header.kind!=0 || header.flags&0x10!=0 || header.size<20 { return Err(ACCESS); }
            let mask=std::ptr::read_unaligned(ace.cast::<u8>().add(4).cast::<u32>());
            if mask!=0x001f01ff || EqualSid(ace.cast::<u8>().add(8).cast(),self.sid)==0 { return Err(ACCESS); }
            Ok(())
        } }
    }
    fn info(h: Handle, directory: bool) -> Result<Info> { unsafe {
        let mut value: Info=zeroed();
        if GetFileInformationByHandle(h,&mut value)==0 { return Err(os_error()); }
        if value.attrs&0x400!=0 || (value.attrs&0x10!=0)!=directory || (!directory && value.links!=1) { return Err(ACCESS); }
        Ok(value)
    } }
    fn open(path: &Path, access: u32, share: u32, creation: u32, directory: bool, security: Option<&Security>) -> Result<Owned> {
        let sa=security.map(Security::sa); let name=wide(path.as_os_str());
        let h=unsafe { CreateFileW(name.as_ptr(),access|READ_CONTROL,share,sa.as_ref().map_or(null(),|v|v),creation,OPEN_REPARSE|if directory {BACKUP}else{0},null_mut()) };
        if h as isize == -1 { return Err(os_error()); }
        let h=Owned(h); info(h.0,directory)?;
        if let Some(sec)=security { sec.check(h.0)?; } Ok(h)
    }
    fn local_app_data() -> Result<PathBuf> { unsafe {
        let id=Guid{a:0xf1b32785,b:0x6fba,c:0x4fcf,d:[0x9d,0x55,0x7b,0x8e,0x7f,0x15,0x70,0x91]}; let mut p=null_mut();
        if SHGetKnownFolderPath(&id,0,null_mut(),&mut p)<0 { return Err(UNAVAILABLE); }
        let mut n=0; while *p.add(n)!=0 && n<32760 { n+=1; }
        let value=String::from_utf16(std::slice::from_raw_parts(p,n)); CoTaskMemFree(p.cast());
        let s=value.map_err(|_|UNAVAILABLE)?;
        if n>=32760 || s.as_bytes().get(1)!=Some(&b':') || s.as_bytes().get(2)!=Some(&b'\\') { return Err(UNAVAILABLE); }
        Ok(PathBuf::from(s))
    } }
    struct Store { path: PathBuf, _parents: Vec<Owned>, _lock: Owned, sec: Security, namespace: [u8;32] }
    impl Store {
        fn new(namespace:[u8;32]) -> Result<Self> {
            let sec=Security::new()?; let root=local_app_data()?;
            let mut parents=Vec::new();
            // Pin every existing ancestor, refusing junctions/reparse points and delete sharing.
            let mut ancestors:Vec<_>=root.ancestors().collect(); ancestors.reverse();
            for path in ancestors { parents.push(open(path,0x80,3,3,true,None)?); }
            let mut path=root;
            for (name,private) in [("Hara".to_string(),false),("credential-vault".to_string(),true),("v1".to_string(),true),(hex(&namespace),true)] {
                path.push(name); let sa=sec.sa();
                let made=unsafe {CreateDirectoryW(wide(path.as_os_str()).as_ptr(),&sa)};
                if made==0 && unsafe{GetLastError()}!=183 { return Err(os_error()); }
                parents.push(open(&path,0x80,3,3,true,if private{Some(&sec)}else{None})?);
            }
            let lock=open(&path.join("store.lock"),GENERIC_READ|GENERIC_WRITE,0,4,false,Some(&sec))?;
            Ok(Self{path,_parents:parents,_lock:lock,sec,namespace})
        }
        fn name(&self, reference:&[u8]) -> Result<PathBuf> { Ok(self.path.join(format!("{}.bin",hex(&hash(reference)?)))) }
        fn entropy(&self, reference:&[u8]) -> Vec<u8> {
            let mut out=SERVICE.to_vec(); out.extend_from_slice(&self.namespace); out.extend_from_slice(reference); out
        }
        fn read(&self, reference:&[u8]) -> Result<Option<Secret>> {
            let path=self.name(reference)?;
            // Missing is classified only at the actual no-follow open, not through exists().
            let name=wide(path.as_os_str());
            let raw=unsafe{CreateFileW(name.as_ptr(),GENERIC_READ|READ_CONTROL,1,null(),3,OPEN_REPARSE,null_mut())};
            if raw as isize == -1 { let e=unsafe{GetLastError()}; return if e==2 {Ok(None)}else{Err(os_error())}; }
            let h=Owned(raw); let fi=info(h.0,false)?; self.sec.check(h.0)?;
            if fi.size_hi!=0 || fi.size_lo==0 || fi.size_lo as usize>MAX_CIPHER { return Err(UNREADABLE); }
            let mut cipher=vec![0;fi.size_lo as usize]; let mut count=0;
            if unsafe{ReadFile(h.0,cipher.as_mut_ptr().cast(),cipher.len() as u32,&mut count,null_mut())}==0 || count as usize!=cipher.len() { return Err(UNREADABLE); }
            let plain=dpapi(&cipher,&self.entropy(reference),false)?;
            let prefix=self.entropy(reference);
            if !plain.0.starts_with(&prefix) || plain.0.len()<prefix.len()+4 { return Err(UNREADABLE); }
            let mut cursor=Cursor{bytes:&plain.0,offset:prefix.len()}; let units=cursor.u32()? as usize;
            if units==0 || units>16384 { return Err(UNREADABLE); }
            let key=Secret(cursor.take(units*2)?.to_vec());
            if cursor.offset!=plain.0.len() || !valid_key(&key.0) { return Err(UNREADABLE); }
            Ok(Some(key))
        }
        fn write(&self, reference:&[u8], key:&[u8]) -> Result<()> {
            // Do not replace an unsafe existing file (including unreadable ciphertext).
            self.read(reference)?;
            let mut plain=Secret(self.entropy(reference)); plain.0.extend_from_slice(&((key.len()/2) as u32).to_le_bytes()); plain.0.extend_from_slice(key);
            let cipher=dpapi(&plain.0,&self.entropy(reference),true)?;
            let mut random=[0u8;16];
            if unsafe{BCryptGenRandom(null_mut(),random.as_mut_ptr(),16,2)}<0 { return Err(UNAVAILABLE); }
            let temp=self.path.join(format!("{}.tmp",hex(&random)));
            let h=open(&temp,GENERIC_READ|GENERIC_WRITE|DELETE,0,1,false,Some(&self.sec))?;
            let result=(|| {
                let mut written=0;
                if unsafe{WriteFile(h.0,cipher.0.as_ptr().cast(),cipher.0.len() as u32,&mut written,null_mut())}==0 || written as usize!=cipher.0.len() || unsafe{FlushFileBuffers(h.0)}==0 { return Err(WRITE_UNKNOWN); }
                let destination=self.name(reference)?; let file_name:Vec<u16>=destination.as_os_str().encode_wide().collect();
                // FILE_RENAME_INFO x64: DWORD union, padding, HANDLE, DWORD byte length, WCHAR[].
                let bytes=20+file_name.len()*2; let mut rename=vec![0usize;(bytes+7)/8]; let p=rename.as_mut_ptr().cast::<u8>();
                unsafe {
                    *p=1; std::ptr::write_unaligned(p.add(8).cast::<Handle>(),null_mut());
                    std::ptr::write_unaligned(p.add(16).cast::<u32>(),(file_name.len()*2) as u32);
                    std::ptr::copy_nonoverlapping(file_name.as_ptr().cast::<u8>(),p.add(20),file_name.len()*2);
                    if SetFileInformationByHandle(h.0,3,p.cast(),bytes as u32)==0 { return Err(WRITE_UNKNOWN); }
                } Ok(())
            })();
            if result.is_err() { let deletion=1i32; unsafe {SetFileInformationByHandle(h.0,4,(&deletion as *const i32).cast(),4);} }
            drop(h); result?;
            match self.read(reference) { Ok(Some(saved)) if saved.0==key => Ok(()), _=>Err(WRITE_UNKNOWN) }
        }
        fn remove(&self, reference:&[u8]) -> Result<()> {
            let path=self.name(reference)?; let raw=unsafe{CreateFileW(wide(path.as_os_str()).as_ptr(),DELETE|READ_CONTROL|0x80,0,null(),3,OPEN_REPARSE,null_mut())};
            if raw as isize == -1 { return if unsafe{GetLastError()}==2 {Ok(())}else{Err(CLEANUP_UNKNOWN)}; }
            let h=Owned(raw); info(h.0,false)?; self.sec.check(h.0)?; let deletion=1i32;
            if unsafe{SetFileInformationByHandle(h.0,4,(&deletion as *const i32).cast(),4)}==0 { return Err(CLEANUP_UNKNOWN); }
            drop(h); if self.read(reference).map_err(|_|CLEANUP_UNKNOWN)?.is_some() { return Err(CLEANUP_UNKNOWN); } Ok(())
        }
    }
    fn dpapi(input:&[u8], entropy:&[u8], protect:bool) -> Result<Secret> { unsafe {
        let input=Blob{len:input.len() as u32,data:input.as_ptr() as *mut u8}; let entropy=Blob{len:entropy.len() as u32,data:entropy.as_ptr() as *mut u8}; let mut output:Blob=zeroed();
        // ONLY UI_FORBIDDEN (1); LOCAL_MACHINE (4) and interactive/audit flags are never set.
        let rc=if protect {CryptProtectData(&input,null(),&entropy,null_mut(),null_mut(),1,&mut output)}else{CryptUnprotectData(&input,null_mut(),&entropy,null_mut(),null_mut(),1,&mut output)};
        if rc==0 { return Err(if protect{UNAVAILABLE}else{UNREADABLE}); }
        let allocation=Local(output.data.cast());
        if output.len as usize>MAX_CIPHER { wipe(std::slice::from_raw_parts_mut(output.data,output.len as usize)); return Err(UNREADABLE); }
        let value=Secret(std::slice::from_raw_parts(output.data,output.len as usize).to_vec());
        wipe(std::slice::from_raw_parts_mut(output.data,output.len as usize)); drop(allocation); Ok(value)
    } }
    struct Cursor<'a> { bytes:&'a [u8], offset:usize }
    impl<'a> Cursor<'a> {
        fn take(&mut self,n:usize)->Result<&'a [u8]> { let end=self.offset.checked_add(n).ok_or(INVALID)?; let out=self.bytes.get(self.offset..end).ok_or(INVALID)?; self.offset=end; Ok(out) }
        fn u16(&mut self)->Result<u16> {Ok(u16::from_le_bytes(self.take(2)?.try_into().map_err(|_|INVALID)?))}
        fn u32(&mut self)->Result<u32> {Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_|INVALID)?))}
    }
    fn valid_ref(r:&[u8])->bool { !r.is_empty() && r.len()<=240 && r.iter().all(|b|b.is_ascii_alphanumeric() || b"_.:-".contains(b)) }
    fn scope(r:&[u8])->&[u8] { r.split(|b|*b==b':').next().unwrap_or(r) }
    fn valid_key(k:&[u8])->bool {
        if k.is_empty() || k.len()%2!=0 || k.len()>32768 { return false; }
        k.chunks_exact(2).all(|b|{let u=u16::from_le_bytes([b[0],b[1]]); !matches!(u,0..=0x20|0x7f|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)})
    }
    fn execute(frame:&[u8], nonce:&mut [u8;16])->Result<Vec<Option<Secret>>> {
        let mut c=Cursor{bytes:frame,offset:0}; if c.take(4)?!=b"HVQ1" {return Err(INVALID);}
        let op=c.take(1)?[0]; nonce.copy_from_slice(c.take(16)?); let namespace:[u8;32]=c.take(32)?.try_into().map_err(|_|INVALID)?; let n=c.u16()? as usize;
        if op>4 || (op==0 && n!=0) || (matches!(op,1|2|4) && n!=1) || (op==3 && (n==0 || n>256)) {return Err(INVALID);}
        let mut entries=Vec::new();
        for _ in 0..n {
            let len=c.u16()? as usize; let reference=c.take(len)?;
            if !valid_ref(reference) || entries.iter().any(|(r,_):&(&[u8],&[u8])|*r==reference) {return Err(INVALID);}
            let units=c.u32()? as usize; if units>16384 {return Err(INVALID);}
            let key=c.take(units*2)?;
            if (matches!(op,2|3) && !valid_key(key)) || (!matches!(op,2|3) && units!=0) {return Err(INVALID);}
            entries.push((reference,key));
        }
        if c.offset!=frame.len() || (op==3 && entries.iter().any(|(r,_)|scope(r)!=scope(entries[0].0))) {return Err(INVALID);}
        let store=Store::new(namespace)?;
        match op {
            0=>{let cipher=dpapi(nonce,&store.entropy(b"probe"),true)?; let clear=dpapi(&cipher.0,&store.entropy(b"probe"),false)?; if clear.0.as_slice()!=nonce.as_slice() {return Err(UNAVAILABLE);} Ok(vec![])},
            1=>Ok(vec![store.read(entries[0].0)?]),
            2|3=>{for (i,(r,k)) in entries.into_iter().enumerate() {if let Err(code)=store.write(r,k) {return Err(if i>0{WRITE_UNKNOWN}else{code});}} Ok(vec![])},
            4=>{store.remove(entries[0].0)?; Ok(vec![])},
            _=>Err(INVALID)
        }
    }
    #[cfg(test)] mod tests { include!("tests.rs"); }
    pub fn run() {
        std::panic::set_hook(Box::new(|_|{}));
        if std::env::args_os().len()!=1 {std::process::exit(64);}
        let mut stdin=std::io::stdin().lock(); let mut size=[0u8;4];
        if stdin.read_exact(&mut size).is_err() {std::process::exit(65);}
        let n=u32::from_le_bytes(size) as usize;
        if !(55..=MAX_FRAME).contains(&n) {std::process::exit(65);}
        let mut frame=Secret(vec![0;n]); let mut trailing=[0u8;1];
        if stdin.read_exact(&mut frame.0).is_err() || stdin.read(&mut trailing).ok()!=Some(0) {std::process::exit(65);}
        let mut nonce=[0;16]; let result=execute(&frame.0,&mut nonce);
        let mut response=Secret(b"HVR1".to_vec()); response.0.extend_from_slice(&nonce);
        match result {
            Ok(values)=>{response.0.push(0);response.0.extend_from_slice(&(values.len() as u16).to_le_bytes());for v in values {match v {None=>response.0.push(0),Some(key)=>{response.0.push(1);response.0.extend_from_slice(&((key.0.len()/2) as u32).to_le_bytes());response.0.extend_from_slice(&key.0);}}}},
            Err(code)=>{response.0.push(code);response.0.extend_from_slice(&0u16.to_le_bytes());}
        }
        let mut stdout=std::io::stdout().lock();
        if stdout.write_all(&(response.0.len() as u32).to_le_bytes()).and_then(|_|stdout.write_all(&response.0)).and_then(|_|stdout.flush()).is_err() {std::process::exit(74);}
    }
}
#[cfg(windows)] fn main() { windows::run(); }
