const fs = require('node:fs');
function check(label, operation) {
  try { console.log(JSON.stringify({label,ok:true,result:operation()})); }
  catch (error) { console.log(JSON.stringify({label,ok:false,name:error.name,code:error.code,message:error.message,stack:error.stack})); }
}
check('localeCompare default', () => 'a'.localeCompare('b'));
check('localeCompare en', () => 'a'.localeCompare('b', 'en'));
check('Intl.Collator', () => new Intl.Collator().resolvedOptions());
check('read ICU data', () => fs.readFileSync('/usr/share/icu/74.2/icudt74l.dat').length);
const skills = process.env.HOME + '/empty-skills';
fs.mkdirSync(skills, {recursive:true});
check('realpathSync JS', () => fs.realpathSync(skills));
check('realpathSync native', () => fs.realpathSync.native(skills));
fs.promises.realpath(skills).then(result => console.log(JSON.stringify({label:'promises realpath',ok:true,result})), error => console.log(JSON.stringify({label:'promises realpath',ok:false,name:error.name,code:error.code,message:error.message,stack:error.stack})));

const compatibleRealpath = require('node:util').promisify(fs.realpath);
check('symlink creation outside grant', () => fs.symlinkSync('/workspace/outside-grant.txt', process.env.TMPDIR + '/escape'));
for (const target of [skills, '/workspace/outside-grant.txt']) {
  compatibleRealpath(target).then(result => console.log(JSON.stringify({label:'compatible realpath',target,ok:true,result})), error => console.log(JSON.stringify({label:'compatible realpath',target,ok:false,code:error.code})));
}
