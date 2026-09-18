# An isolated real-terminal smoke driver, not an agent or a product component.
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, time
spec = json.loads(sys.stdin.read())
child, master = pty.fork()
if child == 0:
    os.chdir(spec['cwd'])
    env = {**os.environ, **spec['env'], 'TERM':'xterm-256color'}
    os.execvpe(spec['command'][0], spec['command'], env)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 120, 0, 0))
output = ''
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
def clean(): return ansi.sub('', output)
def drain(deadline):
    global output
    while time.monotonic()<deadline:
        if select.select([master], [], [], .1)[0]:
            try: data=os.read(master, 65536)
            except OSError: break
            if not data: break
            decoded=data.decode('utf-8','replace')
            output+=decoded
            if '\x1b[6n' in decoded: os.write(master,b'\x1b[1;1R')
        else:
            return
def wait_for(text, start=0):
    deadline = time.monotonic()+25
    while time.monotonic()<deadline:
        if text in clean()[start:]: return
        drain(deadline)
    raise AssertionError('TUI did not show '+repr(text)+'; tail: '+clean()[-2500:])
def wait_ready():
    # Idle TUI: editor box (prompt) plus the built-in footer model id.
    deadline = time.monotonic()+25
    while time.monotonic()<deadline:
        text = clean()
        if '\u2500' in text and 'local' in text: return
        drain(deadline)
    raise AssertionError('TUI did not show prompt/footer; tail: '+clean()[-2500:])
try:
    wait_ready()
    for action in spec['actions']:
        start=len(clean())
        if 'send' in action: os.write(master,action['send'].encode())
        if 'wait' in action: wait_for(action['wait'],start)
    os.write(master,b'\x03')
    os.write(master,b'\x04')
    print(json.dumps({'ok':True,'tail':clean()[-5000:]}))
finally:
    with open(spec['output'],'w') as f: f.write(output)
    # Stop only the child created by this test, never other Pi sessions.
    try: os.kill(child,signal.SIGTERM)
    except ProcessLookupError: pass
    os.close(master)
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        if os.waitpid(child,os.WNOHANG)[0]: break
        time.sleep(.02)
    else:
        try: os.kill(child,signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(child,0)
