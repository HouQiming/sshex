'use strict'
const colors=require('colors/safe');
const path=require('path');
const os=require('os');
const fs=require('fs');
const net=require('net');
const readline = require('readline');
const child_process=require('child_process');
const options=require('commander');
const stringArgv = require('string-argv');
const Client = require('ssh2').Client;
const ESCAPE_KEY='\u0011';
const MAX_LINE_BUF=256;
colors.enabled=1;

var g_commands={
	//todo: install key, maybe HTTP server for port forwarding...
	'help':function(conn,args,callback){
		process.stdout.write([
			"Welcome to the sshex escape prompt, supported commands:\n",
			"  get <remote_file> [local_file]\n",
			"  put [local_file] <remote_file>\n",
			"  port_forward <local_listening_port> <remote_host> <remote_port>\n",
			"  port_reverse <remote_listening_port> <local_host> <local_port>\n",
			"  port_list\n",
			"  port_reset\n",
			"  send_ctrl_q\n",
			"  help\n",
			"\n",
			"The get and put commands operates in ~/Downloads by default.\n",
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
			local_file=path.join(os.homedir(),'Downloads',path.posix.basename(remote_file));
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
		conn.sftp(function(err, sftp) {
			if(err){callback(err);return;}
			sftp.fastGet(remote_file,local_file,function(err) {
				if(!err){
					process.stdout.write(['downloaded ',colors.bold.green(remote_file),' to ',colors.bold.green(local_file),'\n'].join(''));
				}
				sftp.end();
				callback(err);
			});
		});
	},
	'put':function(conn,args,callback){
		if(args.length<2){
			callback(new Error('need a file name\n'));
			return;
		}
		var remote_file,local_file;
		if(args.length<3){
			remote_file=args[1];
			local_file=path.join(os.homedir(),'Downloads',path.posix.basename(remote_file));
		}else{
			remote_file=args[2];
			local_file=path.resolve(os.homedir(),'Downloads',args[1]);
		}
		if(!remote_file.match(/^[~/]/)){
			remote_file=[conn.m_their_pwd,'/',remote_file].join('');
		}
		if(remote_file.match(/^~\//)){
			remote_file=remote_file.slice(2);
		}
		conn.sftp(function(err, sftp) {
			if(err){callback(err);return;}
			sftp.fastPut(local_file,remote_file,function(err) {
				if(!err){
					process.stdout.write(['uploaded ',colors.bold.green(local_file),' to ',colors.bold.green(remote_file),'\n'].join(''));
				}
				sftp.end();
				callback(err);
			});
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
	'send_ctrl_q':function(conn,args){
		conn.m_shell_stream.write(ESCAPE_KEY);
		callback();
	},
};

(function(){
	if(process.stdin.isTTY){
		process.stdin.setRawMode(true);
		process.stdin.setEncoding('utf8');
	}
	process.stdout.setEncoding('utf8');
	process.stderr.setEncoding('utf8');
	(options
		.usage('[options] [user@]hostname [command]')
		.option('-p, --port <port>', 'Specify a port',function(a){return parseInt(a);},22)
		.option('-i, --identity', 'Specify a private key file')
		.option('-t, --pty', 'Request a pty')
		.option('-C, --compression', 'Request compression')
		.option('--win-terminal-rows <rows>', 'Specify the number of rows in a windows terminal emulator')
		.option('--win-terminal-cols <cols>', 'Specify the number of columns in a windows terminal emulator')
		.parse(process.argv));
	if(options.args.length<1||!options.args[0]){
		options.outputHelp();
		return;
	}
	var hostname=options.args[0];
	var parts=hostname.split('@');
	var user=undefined;
	if(parts.length>=2){
		user=parts[0];
		hostname=parts.slice(1).join('@');
	}
	var conn = new Client();
	var in_escape_mode=0;
	var stdout_line_buf=new Buffer(0);
	conn.on('ready', function() {
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
			conn.m_shell_stream=stream;
			stream.on('close', function() {
				conn.end();
				if(options.args.length==1){
					//shell
					console.log('Connection to',hostname,'closed.');
				}
				process.exit();
			}).on('data', function(data) {
				if(data.length>MAX_LINE_BUF){
					stdout_line_buf=new Buffer(data.slice(data.length-MAX_LINE_BUF));
				}else{
					stdout_line_buf=Buffer.concat([stdout_line_buf,data]);
				}
				var pnewline=stdout_line_buf.lastIndexOf(10);
				if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline+1));}
				pnewline=stdout_line_buf.lastIndexOf(7);
				if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline));}
				pnewline=stdout_line_buf.lastIndexOf(27);
				if(pnewline>=0){stdout_line_buf=new Buffer(stdout_line_buf.slice(pnewline));}
				process.stdout.write(data);
			}).stderr.on('data', function(data) {
				process.stderr.write(data);
			});
			process.on('exit', () => {
				stream.end();
			});
			process.stdin.on('data',function(data){
				if(in_escape_mode){return;}
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
							for(var cmd in g_commands){
								if(!line||cmd.indexOf(line)===0){
									hits.push(cmd);
								}
							}
							//todo: tab-over-the-sftp
							callback(null,[hits,line]);
						},
						terminal:true,
						input: process.stdin,
						output: process.stdout,
					});
					conn.m_their_pwd=their_pwd;
					rl.setPrompt(['sshex:',colors.bold.yellow(their_pwd),'$ '].join(''));
					rl.prompt();
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
						process.stdin.resume();
					})
					return;
				}
				stream.write(data);
			});
			if(process.stdout.isTTY){
				process.stdout.on('resize',function(){
					setWindow(process.stdout.rows,process.stdout.columns);
				})
			}
			process.stdin.resume();
		};
		if(options.args.length>=2){
			var cmd_string=options.args.slice(1).join(' ');
			conn.exec(cmd_string,{pty:options.pty},BindStdio);
		}else{
			conn.shell(tty_desc,BindStdio);
		}
	})
	var private_key=undefined;
	if(options.identity){
		try{
			private_key=fs.readFileSync(options.identity);
		}catch(err){
			process.stdout.write(['failed to read ',options.identity].join(''));
		}
	}else{
		var names=['id_rsa','id_dsa','id_ecdsa','id_ed25519'];
		for(var i=0;i<names.length;i++){
			try{
				private_key=fs.readFileSync(path.join(os.homedir(),'.ssh',names[i]));
				break;
			}catch(err){}
		}
	}
	var session_desc={
		host: hostname,
		port: options.port,
		username: user,
		privateKey: private_key,
		compress: !!options.compression,
	};
	conn.once('error',function(err){
		//request password
		if(process.stdin.isTTY){
			if(process.stdin.isTTY){
				process.stdin.setRawMode(true);
				process.stdin.setEncoding('utf8');
			}
			process.stdin.resume();
			process.stdout.write([options.args[0],"'s password: "].join(''));
			var password_array=[];
			var tryAgain=function(canceled){
				process.stdin.removeAllListeners();
				process.stdin.pause();
				if(!canceled){
					session_desc.password=password_array.join('');
					conn.once('error',function(err){
						process.stdout.write([err.message,'\n','Connection failed'].join(''));
					});
					conn.connect(session_desc);
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
		}else{
			process.stdout.write([err.message,'\n','Connection failed'].join(''));
		}
	});
	conn.on('tcp connection', function(info, accept, reject) {
		var callback=conn.m_reversing_ports[info.destPort];
		if(!callback){
			reject();
			return;
		}
		callback(null,accept());
	});
	//initial SIGINT test
	process.stdin.on('data', function (ch) {
		ch = ch.toString('utf8');
		switch (ch) {
		case "\u0003":
			// Ctrl-C
			process.exit(1);
			break;
		}
	});
	process.stdin.resume();
	conn.m_port_reset_jobs=[];
	conn.m_reversing_ports={};
	conn.connect(session_desc);
})();
