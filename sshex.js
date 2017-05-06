#!/usr/bin/env node
'use strict';
const crypto=require('crypto');
const path=require('path');
const os=require('os');
const fs=require('fs');
const net=require('net');
const url=require('url');
const timers=require('timers');
const readline = require('readline');
const child_process=require('child_process');
const options=require('commander');
const colors=require('chalk');
const Minimatch = require("minimatch").Minimatch;
const stringArgv = require('string-argv');
const socks5_client=require("./socks5_client.js");
const Client = require('ssh2').Client;
const ESCAPE_KEY='\u0011';
const MAX_LINE_BUF=256;
colors.enabled=1;

///\brief unified get/put
var RunSCP=function(sftp,path_src,src_file, fs,path_dst,dst_file, options, callback){
	if(typeof(options)==='function'){
		callback=options;
		options={};
	}
	var downloadAll,downloadFile;
	downloadFile=function(src_file,dst_file,callback){
		//console.log(src_file,'=>',dst_file)
		sftp.stat(src_file,function(err,attrs){
			if(err){callback(err);return;}
			fs.stat(dst_file,function(err,attrs_dst){
				if(!err&&attrs_dst.isDirectory()){
					dst_file=path_dst.join(dst_file,path_src.basename(src_file));
				}
				if(attrs.isDirectory()){
					if(options.recursive){
						//recursive download
						downloadAll(src_file,
							{match:function(){return 1;}},
							dst_file,
							callback);
					}else{
						if(options.verbose)process.stdout.write(['skipping directory ',colors.bold.green(options.src_prefix+src_file),'\n'].join(''));
					}
				}else{
					if(sftp.fastGet){
						sftp.fastGet(src_file,dst_file,function(err) {
							if(err){callback(err);return;}
							if(!err){
								if(options.verbose)process.stdout.write(['downloaded ',colors.bold.green(options.src_prefix+src_file),' to ',colors.bold.green(options.dst_prefix+dst_file),'\n'].join(''));
							}
							callback(err);
						});
					}else{
						fs.fastPut(src_file,dst_file,function(err) {
							if(err){callback(err);return;}
							if(!err){
								if(options.verbose)process.stdout.write(['uploaded ',colors.bold.green(options.src_prefix+src_file),' to ',colors.bold.green(options.dst_prefix+dst_file),'\n'].join(''));
							}
							callback(err);
						});
					}
				}
			});
		})
	};
	var downloadAllReal=function(src_dir,matcher,dst_dir,callback){
		sftp.readdir(src_dir,function(err,list) {
			if(err){callback(err);return;}
			var id=0;
			var downloadNext=function(err){
				if(err){callback(err);return;}
				for(;;){
					if(id>=list.length){
						callback();
						return;
					}
					var item=list[id++];
					if(typeof(item)==='object'){
						item=item.filename;
					}
					if(matcher.match(item)){
						downloadFile(path_src.join(src_dir,item),dst_dir,downloadNext);
						break;
					}
				}
			};
			downloadNext();
		});
	};
	downloadAll=function(src_dir,matcher,dst_dir,callback){
		fs.stat(dst_dir,function(err,attrs){
			if(err||!attrs.isDirectory()){
				fs.mkdir(dst_dir,function(err){
					if(err){
						callback(err);
					}else{
						if(options.verbose)process.stdout.write(['created directory ',colors.bold.green(options.dst_prefix+dst_dir),'\n'].join(''));
						downloadAllReal(src_dir,matcher,dst_dir,callback);
					}
				});
			}else{
				downloadAllReal(src_dir,matcher,dst_dir,callback);
			}
		})
	};
	if(src_file.match(/[?*]/)){
		//we need a remote file search
		var src_dir=path_src.dirname(src_file);
		var s_pattern=path_src.basename(src_file);
		var matcher=new Minimatch(s_pattern,{});
		downloadAll(src_dir,matcher,dst_file,function(err){
			callback(err);
		});
	}else{
		downloadFile(src_file,dst_file,function(err){
			callback(err);
		});
	}
};

var g_commands={
	//todo: maybe HTTP proxy server for port forwarding...
	'help':function(conn,args,callback){
		process.stdout.write([
			"Welcome to the sshex escape prompt, supported commands:\n",
			"  get <remote_file> [local_file]\n",
			"  put <local_file> [remote_file]\n",
			"  port_forward <local_listening_port> <remote_host> <remote_port>\n",
			"  port_reverse <remote_listening_port> <local_host> <local_port>\n",
			"  port_list\n",
			"  port_reset\n",
			"  install_key\n",
			"  send_ctrl_q\n",
			"  help\n",
			"\n",
			"The get and put commands operate in ~/Downloads by default.\n",
			"\n",
			"If you see an incorrect path, type this:\n",
			"  export PS1='\\u@\\H:\\w\\$ '\n",
		].join(''));
		callback();
	},
	'get':function(conn,args,callback){
		if(args.length<2){
			callback(new Error('need a file name\n'));
			return;
		}
		var remote_file,local_file;
		if(args.length<3){
			remote_file=args[1];
			local_file=path.join(os.homedir(),'Downloads');
		}else{
			remote_file=args[1];
			local_file=path.resolve(os.homedir(),'Downloads',args[2]);
		}
		if(!remote_file.match(/^[~/]/)){
			remote_file=[conn.m_their_pwd,'/',remote_file].join('');
		}
		if(remote_file.match(/^~\//)){
			remote_file=remote_file.slice(2);
		}
		////////////////////////////
		conn.sftp(function(err, sftp) {
			if(err){callback(err);return;}
			RunSCP(sftp,path.posix,remote_file, fs,path,local_file, {
				recursive:1,
				verbose:1,
				src_prefix:conn.m_session_prefix,
				dst_prefix:'',
			}, callback);
		});
	},
	'put':function(conn,args,callback){
		if(args.length<2){
			callback(new Error('need a file name\n'));
			return;
		}
		var remote_file,local_file;
		local_file=path.resolve(os.homedir(),'Downloads',args[1]);
		if(args.length<3){
			remote_file=path.basename(local_file);
		}else{
			remote_file=args[2];
		}
		if(!remote_file.match(/^[~/]/)){
			remote_file=[conn.m_their_pwd,'/',remote_file].join('');
		}
		if(remote_file.match(/^~\//)){
			remote_file=remote_file.slice(2);
		}
		conn.sftp(function(err, sftp) {
			if(err){callback(err);return;}
			RunSCP(fs,path,local_file, sftp,path.posix,remote_file, {
				recursive:1,
				verbose:1,
				src_prefix:'',
				dst_prefix:conn.m_session_prefix,
			}, callback);
		});
	},
	'port_forward':function(conn,args,callback){
		if(args.length!==4){
			callback(new Error('invalid syntax, please consult help\n'));
			return;
		}
		var remote_host=args[2];
		var remote_port=parseInt(args[3]);
		var server_local=net.createServer(function(socket_local){
			socket_local.pause();
			conn.forwardOut(socket_local.remoteAddr||'127.0.0.1', parseInt(socket_local.remotePort||12345), 
			remote_host, remote_port, function(err, socket_remote) {
				socket_local.resume();
				if(err){
					process.stdout.write([colors.bold.red(err.message),'\n'].join(''));
					socket_local.end();
					return;
				}
				socket_remote.on('error',function(err){
					process.stdout.write([colors.bold.red(err.message),'\n'].join(''));
					socket_local.end();
				})
				socket_remote.on('close',function(){
					socket_local.end();
				}).on('data', function(data) {
					socket_local.write(data);
				});
				socket_local.on('close', function(){
					socket_remote.end();
				}).on('data',function(data){
					socket_remote.write(data);
				});
			});
		});
		server_local.on('error',function(err){
			process.stdout.write([colors.bold.red(err.message),'\n'].join(''));
		});
		server_local.listen({
			port:parseInt(args[1]),
			host:'localhost',
		});
		conn.m_port_reset_jobs.push({type:'forward',server:server_local,desc:args})
		callback();
	},
	'port_reverse':function(conn,args,callback){
		if(args.length!==4){
			callback(new Error('invalid syntax, please consult help\n'));
			return;
		}
		var local_port=parseInt(args[3]);
		var local_host=parseInt(args[2]);
		var remote_port=parseInt(args[1]);
		conn.forwardIn('localhost',remote_port,function(err) {
			if(!err){
				conn.m_port_reset_jobs.push({type:'reverse',port:remote_port,desc:args})
				conn.m_reversing_ports[remote_port]=function(err,socket_remote){
					var socket_local=net.connect({host:local_host,port:local_port});
					socket_local.on('error',function(err){
						process.stdout.write([colors.bold.red(err.message),'\n'].join(''));
						socket_remote.end();
					})
					socket_local.on('close',function(){
						socket_remote.end();
					}).on('data', function(data) {
						socket_remote.write(data);
					});
					socket_remote.on('close', function(){
						socket_local.end();
					}).on('data',function(data){
						socket_local.write(data);
					});
				};
			}
			callback(err);
		});
	},
	'port_list':function(conn,args,callback){
		for(var i=0;i<conn.m_port_reset_jobs.length;i++){
			process.stdout.write(conn.m_port_reset_jobs[i].desc.join(' ')+'\n');
		}
		callback();
	},
	'port_reset':function(conn,args,callback){
		for(var i=0;i<conn.m_port_reset_jobs.length;i++){
			var job_i=conn.m_port_reset_jobs[i];
			if(job_i.type==='forward'){
				job_i.server.close();
			}else{
				conn.unforwardIn('localhost',job_i.port);
				conn.m_reversing_ports[job_i.port]=undefined;
			}
		}
		conn.m_port_reset_jobs=[];
		callback();
	},
	'send_ctrl_q':function(conn,args,callback){
		conn.m_shell_stream.write(ESCAPE_KEY);
		callback();
	},
	'install_key':function(conn,args,callback){
		if(!conn.m_fn_private_key){
			callback(new Error('unable to find your key'));
			return;
		}
		var buf_pubkey=undefined;
		try{
			buf_pubkey=fs.readFileSync([conn.m_fn_private_key,'.pub'].join(''));
		}catch(err){
			callback(new Error('unable to find your key'));
			return;
		}
		if(!buf_pubkey){
			callback(new Error('unable to find your key'));
			return;
		}
		conn.exec(["mkdir -p ~/.ssh;cat >> ~/.ssh/authorized_keys <<'EOF'\n",buf_pubkey.toString(),'EOF\n'].join(''),{pty:false},function(err, stream) {
			if(err){callback(err);return;}
			stream.end();
			process.stdout.write(['installed ',
				colors.bold.green([conn.m_fn_private_key,'.pub'].join('')),' to ',
				colors.bold.green('~/.ssh/authorized_keys'),'\n'].join(''));
			callback();
		});
	},
};

(function(){
	if(process.stdin.isTTY){
		process.stdin.setRawMode(true);
		process.stdin.setEncoding('utf8');
	}
	process.stdout.setEncoding('utf8');
	process.stderr.setEncoding('utf8');
	var collect=function(val,arr){
		arr.push(val);
		return arr;
	};
	(options
		.usage('[options] [user@]hostname [command]')
		.option('-p, --port <port>', 'Specify a port',function(a){return parseInt(a);},22)
		.option('-i, --identity', 'Specify a private key file')
		.option('-t, --pty', 'Request a pty')
		.option('-C, --compression', 'Request compression')
		.option('-L, --port_forward <port_url_port>', 'Forward a remote connection to a local port',collect,[])
		.option('-R, --port_reverse <port_url_port>', 'Forward a local connection to a remote port',collect,[])
		.option('--via <url>', 'Specify a proxy that forwards connection to the final host, can be chained',collect,[])
		.option('--win-alternative-terminal <tty>', 'Specify that the stdin pipe is actually a pty')
		.option('--win-terminal-rows <rows>', 'Specify the number of rows in a windows terminal emulator')
		.option('--win-terminal-cols <cols>', 'Specify the number of columns in a windows terminal emulator')
		.parse(process.argv));
	if(options.args.length<1||!options.args[0]){
		if(options.winAlternativeTerminal){
			options.outputHelp(function(s){return s.replace(/\n/g,'\r\n')});
		}else{
			options.outputHelp();
		}
		return;
	}
	///////////
	var fn_known_hosts=path.join(os.homedir(),'.ssh','known_hosts');
	var known_hosts=[];
	try{
		var data_known_hosts=fs.readFileSync(fn_known_hosts).toString();
		var lines=data_known_hosts.split('\n');
		for(var i=0;i<lines.length;i++){
			var tokens=lines[i].split(' ');
			if(tokens.length!==3){continue;}
			known_hosts.push({
				host_port_array:tokens[0].split(','),
				sig_format:tokens[1],
				key:tokens[2].replace(/\r/g,''),
			});
		}
	}catch(err){};
	var auth_methods=[];
	var private_key=undefined;
	if(options.identity){
		try{
			private_key=fs.readFileSync(options.identity);
			auth_methods.push({type:'key',privateKey:private_key,fn_private_key:options.identity});
		}catch(err){
			process.stdout.write(['Failed to read ',options.identity].join(''));
		}
	}else{
		var names=['id_rsa','id_dsa','id_ecdsa','id_ed25519'];
		for(var i=0;i<names.length;i++){
			try{
				var fn_i=path.join(os.homedir(),'.ssh',names[i]);
				private_key=fs.readFileSync(fn_i);
				auth_methods.push({type:'key',privateKey:private_key,fn_private_key:fn_i});
			}catch(err){}
		}
	}
	if(options.args.length<2){
		auth_methods.push({type:'password'});
	}
	var verification_failed=0;
	var abort=function(){
		process._exitCode=1;
		process.stdin.pause();
		timers.setTimeout(function(){
			process.exit(1);
		},100);
	};
	var CreateSSHConnection=function(session_desc,ssh_callback){
		//todo: move authentication sequence upstream to ssh2... could bundle the keys in an agent, then call authPassword manually
		var conn = new Client();
		var s_session_prefix=[session_desc.username,'@',session_desc.host,':'].join('');
		conn.m_session_prefix=s_session_prefix;
		var p_auth_method=0;
		var callConnect=function(){
			var host_port=session_desc.port===22?session_desc.host:['[',session_desc.host,']:',session_desc.port].join('');
			session_desc.algorithms=undefined;
			for(var i=0;i<known_hosts.length;i++){
				if(known_hosts[i].host_port_array.indexOf(host_port)>=0){
					session_desc.algorithms={serverHostKey:[known_hosts[i].sig_format]};
				}
			}
			conn.once('error',function(err){
				if(err.level==='client-authentication'&&!session_desc.sock){
					doAuth();
				}else{
					ssh_callback(err,conn);
				}
			});
			try{
				conn.connect(session_desc);
			}catch(err){
				process.stdout.write([err.message,'\n'].join(''));
				abort();
				return conn;
			}
			conn._sshstream.once('fingerprint',function(key, verify) {
				var host_port=session_desc.port===22?session_desc.host:['[',session_desc.host,']:',session_desc.port].join('');
				var skey=key.toString('base64');
				var is_good=0;
				var sha1digest=function(skey){
					var sha1=crypto.createHash('sha1');
					sha1.update(new Buffer(skey,'base64'));
					return sha1.digest('hex').toUpperCase().replace(/../g,function(s){return ':'+s}).slice(1);
				};
				for(var i=0;i<known_hosts.length;i++){
					if(known_hosts[i].host_port_array.indexOf(host_port)>=0){
						if(known_hosts[i].key!==skey){
							process.stdout.write([
								colors.bold.red('*** SERVER CHANGED ***'),'\n',
								colors.bold('THIS IS NOT THE SAME '),colors.bold(host_port),colors.bold(' YOU CONNECTED BEFORE!'),'\n',
								'The old server identifies as "',colors.bold(sha1digest(known_hosts[i].key)),'".\n',
								'The new server identifies as "',colors.bold.red(sha1digest(skey)),'".\n',
								'If you still want to connect, delete the line with ',colors.bold(host_port),' from ',colors.bold(fn_known_hosts),'.\n',
							].join(''));
							verification_failed=1;
							verify(0);
							return;
						}else{
							is_good=1;
							break;
						}
					}
				}
				if(is_good){verify(1);return;}
				process.stdout.write([
					colors.bold.yellow('*** FIRST CONNECTION TO THIS SERVER ***'),'\n',
					colors.bold(host_port),' identifies as "',colors.bold(sha1digest(skey)),'".\n',
					"I'm going to remember this server in ",colors.bold(fn_known_hosts),"\n",
				].join(''));
				conn.m_is_new_host={host_port:host_port,skey:skey};
				verify(1);
			});
			conn._sshstream.once('KEXDH_REPLY',function(info){
				if(conn.m_is_new_host){
					fs.appendFileSync(fn_known_hosts,[conn.m_is_new_host.host_port,' ',info.sig_format,' ',conn.m_is_new_host.skey,'\n'].join(''));
					conn.m_is_new_host=undefined;
				}
			});
		};
		var doAuth=function(){
			if(p_auth_method>=auth_methods.length||verification_failed){
				ssh_callback(new Error('All configured authentication methods failed'),conn);
				return;
			}
			var method_i=auth_methods[p_auth_method++];
			if(method_i.type==='key'){
				session_desc.privateKey=method_i.privateKey;
				conn.m_fn_private_key=method_i.fn_private_key;
				callConnect();
			}else{
				//keep the last m_fn_private_key tried
				if(process.stdin.isTTY){
					process.stdin.setRawMode(true);
					process.stdin.setEncoding('utf8');
				}
				process.stdin.removeAllListeners();
				process.stdin.resume();
				process.stdout.write([options.args[0],"'s password: "].join(''));
				var password_array=[];
				var tryAgain=function(canceled){
					process.stdin.removeAllListeners();
					process.stdin.pause();
					if(!canceled){
						session_desc.password=password_array.join('');
						session_desc.privateKey=undefined;
						callConnect();
					}else{
						process.exit(1);
					}
				}
				process.stdin.on('data', function (ch) {
					ch = ch.toString('utf8');
					switch (ch) {
					case "\n":
					case "\r":
					case "\u0004":
						// They've finished typing their password
						process.stdout.write('\n');
						tryAgain(false);
						break;
					case "\u0003":
						// Ctrl-C
						tryAgain(true);
						break;
					case '\u0008':
						if(password_array.length){password_array.pop();}
						break;
					default:
						// More passsword characters
						password_array.push(ch);
						break;
					}
				});
			}
		};
		conn.on('ready',function(){
			ssh_callback(null,conn);
		})
		doAuth();
	};
	///////////////////////////////
	var hostname=options.args[0];
	var parts=hostname.split('@');
	var user=undefined;
	if(parts.length>=2){
		user=parts[0];
		hostname=parts.slice(1).join('@');
	}
	var session_desc={
		host: hostname,
		port: options.port||22,
		username: user,
		compress: !!options.compression,
	};
	var stdin_queue=[];
	var runMainPart=function(session_desc){
		CreateSSHConnection(session_desc,function(err,conn){
			if(err){
				process.stdout.write(['Failed to connect to "',conn.m_session_prefix.slice(0,conn.m_session_prefix.length-1),'": ',err.message,'\n'].join(''));
				abort();
				return;
			}
			var in_escape_mode=0;
			var stdout_line_buf=new Buffer(0);
			var line_buf_enabled=1;
			conn.on('tcp connection', function(info, accept, reject) {
				var callback=conn.m_reversing_ports[info.destPort];
				if(!callback){
					reject();
					return;
				}
				callback(null,accept());
			});
			conn.m_port_reset_jobs=[];
			conn.m_reversing_ports={};
			process.stdin.removeAllListeners();
			var tty_desc={};
			if(process.stdout.isTTY){
				tty_desc={
					rows:process.stdout.rows,
					cols:process.stdout.columns,
					term:process.env["TERM"]||"cygwin",
				};
			}else{
				//if(process.platform==='win32'){
				//	tty_desc.rows=parseInt(process.env["LINES"]);
				//	tty_desc.cols=parseInt(process.env["COLUMNS"])
				//}
				if(options.winTerminalRows){tty_desc.rows=parseInt(options.winTerminalRows);}
				if(options.winTerminalCols){tty_desc.cols=parseInt(options.winTerminalCols);}
				if(tty_desc.rows||tty_desc.cols){
					tty_desc.term=process.env["TERM"];
					process.stdout.columns=tty_desc.cols;
				}
			}
			var BindStdio=function(err, stream) {
				if (err){throw err;}
				var rl=undefined;
				var winch_catcher=null;
				conn.m_shell_stream=stream;
				stream.on('close', function() {
					conn.end();
					if(options.args.length==1){
						//shell
						console.log('Connection to',hostname,'closed.');
					}
					if(winch_catcher){
						winch_catcher.kill('SIGINT');
						winch_catcher.on('exit',function(){
							process.exit();
						});
					}else{
						process.exit();
					}
				}).on('data', function(data) {
					if(line_buf_enabled){
						if(data.length>MAX_LINE_BUF){
							stdout_line_buf=new Buffer(data.slice(data.length-MAX_LINE_BUF));
						}else{
							stdout_line_buf=Buffer.concat([stdout_line_buf,data]);
						}
						var pnewline=stdout_line_buf.lastIndexOf(10);
						if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline+1));}
						pnewline=stdout_line_buf.lastIndexOf(7);
						if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline+1));}
						pnewline=stdout_line_buf.lastIndexOf(27);
						if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline));}
					}
					process.stdout.write(data);
				}).stderr.on('data', function(data) {
					process.stderr.write(data);
				});
				process.on('exit', () => {
					stream.end();
				});
				process.stdin.on('data',function(data){
					if(in_escape_mode){return;}
					line_buf_enabled=0;
					if(data.length===1&&data[0]===13){
						line_buf_enabled=1;
					}
					if(data.length===1&&data.toString('utf8')===ESCAPE_KEY){
						//get pwd from their bash prompt - keep a line buffer, use it to determine our prompt
						var s_bash_prompt=stdout_line_buf.toString('utf8');
						var match=s_bash_prompt.match(/\[[^ ]* (.*)\][#$][ \t]*$/);
						if(!match){match=s_bash_prompt.match(/[^ :]*:(.*)[#$][ \t]*$/);}
						var their_pwd='~';
						if(match){
							their_pwd=match[1];
						}
						//enter the escape mode
						in_escape_mode=1;
						rl=readline.createInterface({
							completer:function(line,callback){
								var hits=[];
								var args=stringArgv(line);
								if(args.length>1&&args[0]==='get'){
									//tab-over-the-sftp
									var last_arg=args.pop();
									var remote_basename=path.posix.basename(last_arg);
									var remote_dir=path.posix.dirname(last_arg);
									if(last_arg.match(/[/]$/)){
										remote_basename='';
										remote_dir=last_arg;
									}
									if(!remote_dir){
										remote_dir=conn.m_their_pwd;
									}else if(!remote_dir.match(/^[~/]/)){
										remote_dir=[conn.m_their_pwd,'/',remote_dir].join('');
									}
									if(remote_dir.match(/^~\//)){
										remote_dir=remote_dir.slice(2);
									}
									conn.sftp(function(err, sftp) {
										if(err){callback(null,[hits,line]);return;}
										sftp.readdir(remote_dir,function(err,list) {
											sftp.end();
											if(err){callback(null,[hits,line]);return;}
											var hits_all=list.map(a=>a.filename+(a.attrs.isDirectory()?'/':''));
											var hist_match=hits_all.filter(a=>(a.indexOf(remote_basename)===0));
											callback(null,[hist_match.length?hist_match:hits_all,remote_basename]);
										});
									});
								}else if(args.length>1&&args[0]==='put'){
									var last_arg=args.pop();
									var local_basename=path.basename(last_arg);
									var local_dir=path.dirname(last_arg);
									if(last_arg.match(/[\\/]$/)){
										local_basename='';
										local_dir=last_arg;
									}
									local_dir=path.resolve(os.homedir(),'Downloads',local_dir);
									fs.readdir(local_dir,function(err,list) {
										if(err){callback(null,[hits,line]);return;}
										var isdirSafe=function(fn){
											try{
												return fs.statSync(fn).isDirectory();
											}catch(err){
												return 0;
											}
										};
										var hits_all=list.map(a=>a+(isdirSafe(path.join(local_dir,a))?path.sep:''));
										var hist_match=hits_all.filter(a=>(a.indexOf(local_basename)===0));
										callback(null,[hist_match.length?hist_match:hits_all,local_basename]);
									});
								}else{
									for(var cmd in g_commands){
										if(!line||cmd.indexOf(line)===0){
											hits.push(cmd);
										}
									}
									callback(null,[hits,line]);
								}
							},
							terminal:true,
							input: process.stdin,
							output: process.stdout,
						});
						conn.m_their_pwd=their_pwd;
						rl.setPrompt(['sshex:',colors.bold.green(their_pwd),'$ '].join(''));
						rl.prompt();
						rl.on('SIGINT',function(line){
							process.stdout.write('\r\u001b[0K'+s_bash_prompt);
							rl.close();
						});
						rl.on('line',function(line){
							rl.pause();
							var args=stringArgv(line);
							var commandIsDone=function(err){
								if(err){
									process.stdout.write([colors.bold.red(err.message),'\n'].join(''));
								}
								process.stdout.write(s_bash_prompt);
								rl.close();
							};
							if(args.length>0&&g_commands[args[0]]){
								g_commands[args[0]](conn,args,commandIsDone);
							}else{
								commandIsDone(args[0]?new Error(['invalid command: "',args[0],'"'].join('')):undefined);
							}
						});
						rl.on('close',function(){
							in_escape_mode=0;
							rl=undefined;
							if(process.stdin.isTTY){
								process.stdin.setRawMode(true);
								process.stdin.setEncoding('utf8');
							}
							process.stdin.resume();
						})
						return;
					}
					stream.write(data);
				});
				if(process.stdout.isTTY){
					process.stdout.on('resize',function(){
						stream.setWindow(process.stdout.rows,process.stdout.columns);
					})
				}else if(options.winAlternativeTerminal){
					winch_catcher=child_process.spawn("sh.exe",[path.join(__dirname,"catch_winch.sh"),options.winAlternativeTerminal],{
						stdio:['ignore', 'inherit', 'pipe']
					},function(){
						//do nothing
					});
					if(winch_catcher){
						winch_catcher.stderr.on('data',function(data){
							try{
								var s=data.toString();
								var wnd=s.replace(/[\r\n]/g,'').split(' ');
								stream.setWindow(parseInt(wnd[0]),parseInt(wnd[1]));
							}catch(err){
								//do nothing
							}
						})
					}
				}
				if(stdin_queue.length){
					stream.write(Buffer.concat(stdin_queue));
				}
				process.stdin.resume();
			};
			//blindly start port forwarding
			for(var i=0;i<options.port_forward.length;i++){
				g_commands.port_forward(conn,['port_forward'].concat(options.port_forward[i].split(':')),function(){});
			}
			for(var i=0;i<options.port_reverse.length;i++){
				g_commands.port_reverse(conn,['port_reverse'].concat(options.port_reverse[i].split(':')),function(){});
			}
			if(options.args.length>=2){
				var cmd_string=options.args.slice(1).join(' ');
				conn.exec(cmd_string,{pty:options.pty},BindStdio);
			}else{
				conn.shell(tty_desc,BindStdio);
			}
		});
	};
	//initial SIGINT test
	process.stdin.on('data', function (ch) {
		stdin_queue.push(ch);
		ch = ch.toString('utf8');
		switch (ch) {
		case "\u0003":
			// Ctrl-C
			process.exit(1);
			break;
		}
	});
	process.stdin.resume();
	//////////////
	var fnext_step=runMainPart;
	var chainStep=function(fcurrent_step){
		var f=fnext_step;
		fnext_step=function(my_session_desc){
			fcurrent_step(my_session_desc,f);
		}
	};
	var need_sock=0;
	for(var i=options.via.length-1;i>=0;i--){
		var proxy_url=url.parse(options.via[i]);
		if(!proxy_url.protocol){
			proxy_url=url.parse('ssh://'+options.via[i]);
		}
		var fstep_proxy=undefined;
		switch(proxy_url.protocol){
		default:{
			process.stdout.write(['unsupported proxy protocol "',options.via[i],'"\n'].join(''));
			abort();
			return;
		}break;case 'ssh:':{
			proxy_url.port=(proxy_url.port||22);
			chainStep(function(proxy_url,next_session_desc,my_session_desc,callback){
				CreateSSHConnection({
					host:proxy_url.host,
					port:proxy_url.port,
					username:proxy_url.auth,
					sock:my_session_desc.sock,
				},function(err,conn){
					if(err){
						process.stdout.write(['proxy "',proxy_url.href,'" has failed: ',err.message,'\n'].join(''));
						abort();
						return;
					}
					conn.forwardOut('127.0.0.1',12345,
					next_session_desc.host, parseInt(next_session_desc.port),function(err, socket_remote) {
						if(err){
							process.stdout.write(['proxy "',proxy_url.href,'" has failed: ',err.message,'\n'].join(''));
							abort();
							conn.end();
							return;
						}
						process.stdout.write(['connected to proxy "',colors.bold.yellow(proxy_url.href),'"\n'].join(''));
						next_session_desc.sock=socket_remote;
						socket_remote.on('close',function(){
							conn.end();
						})
						callback(next_session_desc);
					});
				});
			}.bind(this,proxy_url,session_desc));
			need_sock=0;
		}break;case 'http:':{
			proxy_url.port=(proxy_url.port||80);
			chainStep(function(proxy_url,next_session_desc,my_session_desc,callback){
				var errored=0;
				var socket=my_session_desc.sock;
				socket.once('data',function(data){
					var pcrlf=data.indexOf('\r\n\r\n');
					if(pcrlf>=0){
						if(data.slice(0,pcrlf+4).toString().match('^HTTP[^ ]* 200 .*\r\n')){
							data=data.slice(pcrlf+4);
							if(data.length){
								timers.setImmediate(()=>{
									socket.emit('data',data);
								});
							}
							process.stdout.write(['connected to proxy "',colors.bold.yellow(proxy_url.href),'"\n'].join(''));
							next_session_desc.sock=socket;
							callback(next_session_desc);
							return;
						}
					}
					console.log(data.toString());
					errored=1;
					process.stdout.write(['proxy "',proxy_url.href,'" has failed: request rejected\n'].join(''));
					socket.end();
					abort();
				})
				socket.once('error',function(err){
					if(errored){return;}
					errored=1;
					process.stdout.write(['proxy "',proxy_url.href,'" has failed: ',err.message,'\n'].join(''));
					abort();
				});
				socket.once('close',function(){
					if(errored){return;}
					errored=1;
					process.stdout.write(['proxy "',proxy_url.href,'" has failed: connection closed prematurely\n'].join(''));
					abort();
				});
				// 
				socket.write(['CONNECT ',next_session_desc.host,':',next_session_desc.port,' HTTP/1.0\r\n',
					proxy_url.auth?'Proxy-Authorization: Basic '+new Buffer(proxy_url.auth).toString('base64')+'\r\n':'',
					'Host: ',next_session_desc.host,':',next_session_desc.port,'\r\n\r\n'].join(''))
			}.bind(this,proxy_url,session_desc));
			need_sock=1;
		}break;case 'socks5:':{
			proxy_url.port=(proxy_url.port||1080);
			chainStep(function(proxy_url,next_session_desc,my_session_desc,callback){
				var socks5_options={
					socket:my_session_desc.sock,
				};
				if(proxy_url.auth){
					var auth_info=proxy_url.auth.split(':');
					if(auth_info.length>=2){
						socks5_options.socksUsername=auth_info[0];
						socks5_options.socksPassword=auth_info.slice(1).join(':');
					}else{
						process.stdout.write(['you have to specify a password for "',proxy_url.href,'"\n'].join(''));
						abort();
						return;
					}
				}
				var socket=new socks5_client(socks5_options);
				var deed_done=0;
				socket.connect(next_session_desc.port,next_session_desc.host);
				socket.once('connect',function(){
					deed_done=1;
					process.stdout.write(['connected to proxy "',colors.bold.yellow(proxy_url.href),'"\n'].join(''));
					next_session_desc.sock=socket;
					callback(next_session_desc);
				});
				socket.setTimeout(20000);
				socket.once('timeout',function(){
					if(deed_done){return;}
					deed_done=1;
					socket.end();
				});
				socket.once('close',function(){
					if(deed_done){return;}
					deed_done=1;
					process.stdout.write(['proxy "',proxy_url.href,'" has failed: connection closed prematurely\n'].join(''));
					abort();
				});
				socket.once('error',function(err){
					if(deed_done){return;}
					deed_done=1;
					process.stdout.write(['proxy "',proxy_url.href,'" has failed: ',err.message,'\n'].join(''));
					abort();
				});
			}.bind(this,proxy_url,session_desc));
			need_sock=1;
		}}
		session_desc={
			host:proxy_url.hostname,
			port:proxy_url.port,
		};
	}
	if(need_sock){
		chainStep((session_desc,callback)=>{
			var socket=net.connect(session_desc);
			var errored=0;
			session_desc.sock=socket;
			socket.once('connect',function(){
				socket.removeAllListeners();
				callback(session_desc);
			});
			socket.setTimeout(20000);
			socket.once('timeout',function(){
				socket.end();
			});
			socket.once('close',function(){
				if(errored){return;}
				errored=1;
				process.stdout.write(['Our connection to "',session_desc.host,':',session_desc.port,'" was closed prematurely\n'].join(''));
				abort();
			});
			socket.once('error',function(err){
				if(errored){return;}
				errored=1;
				process.stdout.write(['Failed to connect to "',session_desc.host,':',session_desc.port,'": ',err.message,'\n',].join(''));
				abort();
			});
		});
	}
	fnext_step(session_desc);
})();
