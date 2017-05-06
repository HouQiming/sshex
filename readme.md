## Why

- Download / upload files in the middle of an SSH session
- Tunnel an SSH connection through an HTTPS / SOCKS5 proxy or another SSH server
- Native MSYS / Cygwin support

## Install

```console
npm install -g sshex
sshex --help
```

## Examples

Debug an image-generating program remotely:

```console
sshex user@example.com
cd my_awesome_project
make test
<CTRL+Q>get result.png
```

Connect to a swarm worker behind a swarm manager from behind your corporation firewall:

```console
sshex --via http://proxy.your.corporation.com --via ssh://user@that.swarm.manager.com root@${WORKER_IP_ADDRESS}
```
