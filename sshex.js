'use strict'
const path=require('path');
const os=require('os');
const fs = require('fs');
const options=require('commander');
const Client = require('ssh2').Client;
const readline = require('readline');

(function(){
	(options
		.usage('[options] [user@]hostname [command]')
		.option('-p, --port <port>', 'Specify a port',function(a){return parseInt(a);},22)
		.option('-i, --identity', 'Specify a private key file')
		.option('-t, --pty', 'Request a pty')
		.option('-C, --compression', 'Request compression')
		.parse(process.argv));
	if(options.args.length<1){
		options.outputHelp();
		return;
	}
	if(process.stdin.isTTY){
		process.stdin.setRawMode(true);
		process.stdin.setEncoding('utf8');
	}
	var hostname=options.args[0];
	var parts=hostname.split('@');
	var user=undefined;
	if(parts.length>=2){
		user=parts[0];
		hostname=parts.slice(1).join('@');
	}
	var conn = new Client();
	conn.on('ready', function() {
		var tty_desc={};
		if(process.stdout.isTTY){
			tty_desc={
					rows:process.stdout.rows,
					cols:process.stdout.columns,
					term:process.env["TERM"]||"cygwin",
			};
		}else{
			//todo
		}
		var BindStdio=function(err, stream) {
			if (err) throw err;
			stream.on('close', function() {
				conn.end();
				console.log('connection closed');
				process.exit();
			}).on('data', function(data) {
				process.stdout.write(data);
			}).stderr.on('data', function(data) {
				process.stderr.write(data);
			});
			process.on('exit', () => {
				stream.end();
			});
			process.stdin.on('data',function(data){
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
			var cmd_string=options.args.slice(1).join(';');
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
	conn.connect(session_desc);
})();
