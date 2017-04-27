'use strict'
const child_process=require('child_process');
const path=require('path');
const fs=require('fs');

/*
We need to manually create wrappers for Windows:
	Window BAT (sshex.cmd):
	Cygwin shell (sshex.sh):
	Unix (sshex.js):
		just create a symlink
*/
(function(){
	if(process.argv.length<3){
		return;
	}
	var path_bin_root=child_process.execSync('npm bin -g').toString().replace(/\n/g,'');
	//npm bin -g
	if(process.argv[2]==='install'){
		if(process.platform==='win32'){
			fs.writeFileSync(path.join(path_bin_root,'sshex.cmd'),fs.readFileSync(path.join(__dirname,'sshex.cmd')).toString()
				.replace(/c:\\tp\\sshex\\sshex\.js/g,path.join(__dirname,'sshex.js')));
			fs.writeFileSync(path.join(path_bin_root,'sshex'),fs.readFileSync(path.join(__dirname,'sshex.sh')).toString()
				.replace(/\/c\/tp\/sshex\/sshex\.js/g,'/'+path.join(__dirname,'sshex.js').replace(/\\/g,'/').replace(/:/,'')));
		}else{
			try{
				fs.symlinkSync(path.join(path_bin_root,'sshex'),path.join(__dirname,'sshex.js'));
			}catch(err){
				fs.unlinkSync(path.join(path_bin_root,'sshex'));
				fs.symlinkSync(path.join(path_bin_root,'sshex'),path.join(__dirname,'sshex.js'));
			}
			fs.chmodSync(path.join(__dirname,'sshex.js'),0o755);
		}
	}else{
		if(process.platform==='win32'){
			fs.unlinkSync(path.join(path_bin_root,'sshex.cmd'));
			fs.unlinkSync(path.join(path_bin_root,'sshex'));
		}else{
			fs.unlinkSync(path.join(path_bin_root,'sshex'));
		}
	}
})();
