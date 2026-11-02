'use strict';
const call=(method,args)=>globalThis.__almaPlatformCall(method,args);
exports.readFile=async(path,encoding)=>{
  const result=await call('resources.read',{path:String(path)});
  const bytes=Buffer.from(result.base64,'base64');return encoding?bytes.toString(encoding):bytes;
};
exports.lstat=async(path)=>{
  const m=await call('storage.metadata',{path:String(path)});
  return {...m,isDirectory:()=>m.kind==='directory',isFile:()=>m.kind==='file',isSymbolicLink:()=>m.kind==='symlink'};
};
