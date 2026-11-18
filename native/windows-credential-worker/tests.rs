use super::*;
#[repr(C)] struct UserInfo { name:*const u16,password:*const u16,age:u32,privilege:u32,home:*const u16,comment:*const u16,flags:u32,script:*const u16 }
#[repr(C)] struct Profile { size:u32,flags:u32,name:*const u16,path:*const u16,default_path:*const u16,server:*const u16,policy:*const u16,handle:Handle }
#[repr(C)] struct Luid { low:u32,high:i32 }
#[repr(C)] struct Privilege { count:u32,luid:Luid,attrs:u32 }
#[link(name="netapi32")] extern "system" {
    fn NetUserAdd(server:*const u16,level:u32,data:*const c_void,error:*mut u32)->u32;
    fn NetUserDel(server:*const u16,name:*const u16)->u32;
}
#[link(name="advapi32")] extern "system" {
    fn LogonUserW(name:*const u16,domain:*const u16,password:*const u16,kind:u32,provider:u32,token:*mut Handle)->i32;
    fn ImpersonateLoggedOnUser(token:Handle)->i32;
    fn RevertToSelf()->i32;
    fn LookupPrivilegeValueW(system:*const u16,name:*const u16,luid:*mut Luid)->i32;
    fn AdjustTokenPrivileges(token:Handle,disable:i32,state:*const Privilege,len:u32,previous:*mut c_void,needed:*mut u32)->i32;
}
#[link(name="userenv")] extern "system" {
    fn LoadUserProfileW(token:Handle,profile:*mut Profile)->i32;
    fn UnloadUserProfile(token:Handle,profile:Handle)->i32;
}
#[link(name="kernel32")] extern "system" {
    fn MoveFileExW(old:*const u16,new:*const u16,flags:u32)->i32;
}
fn enable_privilege(name:&str) { unsafe {
    let mut h=null_mut(); assert!(OpenProcessToken(GetCurrentProcess(),40,&mut h)!=0,"test privilege token"); let h=Owned(h);
    let mut state=Privilege{count:1,luid:Luid{low:0,high:0},attrs:2};
    assert!(LookupPrivilegeValueW(null(),wstr(name).as_ptr(),&mut state.luid)!=0,"test privilege lookup");
    assert!(AdjustTokenPrivileges(h.0,0,&state,0,null_mut(),null_mut())!=0 && GetLastError()==0,"test privilege enable");
} }
struct Account { name:Vec<u16>,token:Option<Owned>,profile:Handle,impersonating:bool }
impl Drop for Account { fn drop(&mut self) { unsafe {
    if self.impersonating {RevertToSelf();}
    if let Some(token)=&self.token {if !self.profile.is_null() {UnloadUserProfile(token.0,self.profile);}}
    self.token.take(); if !self.name.is_empty() {NetUserDel(null(),self.name.as_ptr());}
} } }
fn namespace() -> [u8;32] { let mut n=[0;32]; assert!(unsafe{BCryptGenRandom(null_mut(),n.as_mut_ptr(),32,2)}>=0,"test RNG"); n }
#[test] fn current_user_dpapi_and_real_second_user_rejection() { unsafe {
    assert!(std::env::var("GITHUB_ACTIONS").ok().as_deref()==Some("true"),"ephemeral Windows CI only");
    let canary=Secret(b"synthetic-native-canary-not-provider-material".to_vec()); let entropy=b"hara-native-cross-user-test-v1";
    let own=dpapi(&canary.0,entropy,true).unwrap_or_else(|_|panic!("own protect"));
    assert!(dpapi(&own.0,entropy,false).map(|v|v.0==canary.0).unwrap_or(false),"own roundtrip");
    enable_privilege("SeBackupPrivilege"); enable_privilege("SeRestorePrivilege");
    let random=namespace(); let name=wstr(&format!("hv{}",hex(&random[..6]))); let mut password=wstr(&format!("Aa1!{}",hex(&random[6..])));
    let data=UserInfo{name:name.as_ptr(),password:password.as_ptr(),age:0,privilege:1,home:null(),comment:null(),flags:0x10201,script:null()};
    assert!(NetUserAdd(null(),1,(&data as *const UserInfo).cast(),null_mut())==0,"create real ephemeral user");
    let mut account=Account{name,token:None,profile:null_mut(),impersonating:false}; let mut token=null_mut();
    let logon=LogonUserW(account.name.as_ptr(),wstr(".").as_ptr(),password.as_ptr(),2,0,&mut token);
    wipe(std::slice::from_raw_parts_mut(password.as_mut_ptr().cast::<u8>(),password.len()*2));
    assert!(logon!=0,"real second-user interactive token"); account.token=Some(Owned(token));
    let mut profile=Profile{size:size_of::<Profile>() as u32,flags:1,name:account.name.as_ptr(),path:null(),default_path:null(),server:null(),policy:null(),handle:null_mut()};
    assert!(LoadUserProfileW(token,&mut profile)!=0,"load usable second-user DPAPI profile"); account.profile=profile.handle;
    let ns=namespace(); let store=Store::new(ns).unwrap_or_else(|_|panic!("own store"));
    let key=Secret(b"a\0b\0c\0".to_vec()); assert!(store.write(b"test:cross-user",&key.0).is_ok(),"own storage");
    let file=store.name(b"test:cross-user").unwrap();
    assert!(ImpersonateLoggedOnUser(token)!=0,"impersonate real second user"); account.impersonating=true;
    assert!(dpapi(&own.0,entropy,false).is_err(),"foreign user cannot decrypt original blob");
    let foreign=dpapi(&canary.0,entropy,true).unwrap_or_else(|_|panic!("foreign profile can protect"));
    assert!(dpapi(&foreign.0,entropy,false).map(|v|v.0==canary.0).unwrap_or(false),"foreign profile positive control");
    let raw=CreateFileW(wide(file.as_os_str()).as_ptr(),GENERIC_READ|READ_CONTROL,1,null(),3,OPEN_REPARSE,null_mut());
    if raw as isize != -1 {CloseHandle(raw);panic!("foreign user unexpectedly read private store");}
    assert!(GetLastError()==5,"private DACL denies actual second user");
    assert!(RevertToSelf()!=0,"revert identity"); account.impersonating=false;
    assert!(dpapi(&foreign.0,entropy,false).is_err(),"original user cannot decrypt second-user blob");
    assert!(store.remove(b"test:cross-user").is_ok(),"own cleanup");
    let private=store.path.clone();drop(store);assert!(std::fs::remove_dir_all(private).is_ok(),"remove exact native fixture namespace");
    assert!(UnloadUserProfile(token,account.profile)!=0,"unload test user profile"); account.profile=null_mut();
    account.token.take(); assert!(NetUserDel(null(),account.name.as_ptr())==0,"delete test OS user");account.name.clear();
} }
#[test] fn ancestor_handles_block_directory_replacement_during_actual_io() {
    assert!(std::env::var("GITHUB_ACTIONS").ok().as_deref()==Some("true"),"ephemeral Windows CI only");
    let store=Store::new(namespace()).unwrap_or_else(|_|panic!("pinned store"));
    for dir in store.path.ancestors().take(3) {
        let original=wide(dir.as_os_str()); let replacement=wide(dir.with_extension("renamed").as_os_str());
        let renamed=unsafe{MoveFileExW(original.as_ptr(),replacement.as_ptr(),0)}!=0;
        if renamed {
            let restored=unsafe{MoveFileExW(replacement.as_ptr(),original.as_ptr(),0)}!=0;
            assert!(restored,"restore renamed ephemeral fixture");
        }
        assert!(!renamed,"the namespace, v1 and credential-vault handles must each block replacement");
    }
    let key=Secret(b"p\0i\0n\0".to_vec());assert!(store.write(b"pinned:original",&key.0).is_ok(),"IO remains on original pinned directory");
    assert!(store.remove(b"pinned:original").is_ok(),"targeted cleanup");let private=store.path.clone();drop(store);
    assert!(std::fs::remove_dir_all(private).is_ok(),"remove exact native fixture namespace");
}

#[test] fn pre_lock_busy_and_pending_quota_preserve_the_committed_credential() {
    assert!(std::env::var("GITHUB_ACTIONS").ok().as_deref()==Some("true"),"ephemeral Windows CI only");
    let ns=namespace();
    let store=Store::new(ns).unwrap_or_else(|_|panic!("private store"));
    assert!(matches!(Store::new(ns),Err(LOCK_BUSY)),"the competing opener fails at the exact exclusive lock");
    let key=b"a\0b\0c\0"; let other=b"x\0y\0z\0";
    assert!(store.write_key(b"quota:published",key,true).is_ok());
    assert!(matches!(store.write_key(b"quota:published",other,true),Err(REF_EXISTS)));
    for i in 0..MAX_PENDING_TEMPS {
        std::fs::write(store.path.join(format!("{i:032x}.tmp")),b"opaque synthetic unfinished ciphertext").unwrap();
    }
    assert!(matches!(store.check_pending_quota(),Err(UNAVAILABLE)));
    assert_eq!(std::fs::read_dir(&store.path).unwrap().count(),MAX_PENDING_TEMPS+2);
    assert!(store.read(b"quota:published").unwrap().unwrap().0==key);
    let private=store.path.clone(); drop(store);
    assert!(std::fs::remove_dir_all(private).is_ok(),"remove exact native fixture namespace");
}
