'use strict';
const normalize=p=>{const absolute=p.startsWith('/'),out=[];for(const c of p.split('/')){
  if(!c||c==='.')continue;if(c==='..'){if(out.length&&out.at(-1)!=='..')out.pop();else if(!absolute)out.push(c);}else out.push(c);
}return (absolute?'/':'')+out.join('/')||'.';};
exports.isAbsolute=p=>p.startsWith('/');exports.normalize=normalize;
exports.join=(...p)=>normalize(p.filter(Boolean).join('/'));
exports.resolve=(...p)=>{let result='';for(const x of p)result=x.startsWith('/')?x:`${result}/${x}`;return normalize(result.startsWith('/')?result:`/${result}`);};
exports.dirname=p=>{const n=normalize(p);if(n==='/')return '/';const i=n.lastIndexOf('/');return i<0?'.':i===0?'/':n.slice(0,i);};
exports.basename=p=>normalize(p).split('/').at(-1);
exports.sep='/';exports.posix=exports;
