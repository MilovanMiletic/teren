import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Runs a command and returns its output. Inherits nothing: everything is captured so `prepare`
 * can read a token out of stdout, and echoed line by line so a long build still looks alive.
 */
export function run(command, args, { cwd, env, stdin, quiet = false, label } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
    });

    let out = '';
    let err = '';

    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!quiet) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (!quiet) process.stderr.write(chunk);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ out, err, code });
        return;
      }
      reject(
        new Error(
          `${label ?? command} exited ${code}\n${out.slice(-2000)}\n${err.slice(-2000)}`,
        ),
      );
    });

    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * The Angular CLI, invoked as a script rather than through `npx`.
 *
 * Node 24 refuses to `spawn` a `.cmd` shim without `shell: true` (`EINVAL`), and turning the
 * shell on would put every argument through cmd.exe quoting. The CLI is a plain Node program, so
 * it is run as one.
 */
export function ngArgs(webRoot, args) {
  return [resolve(webRoot, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'), ...args];
}
