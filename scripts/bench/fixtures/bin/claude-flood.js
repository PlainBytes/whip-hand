// The bench's stand-in for an interactive `claude` (see ../flood.yaml): ~2 MB
// of colored, wrapped terminal output, then idle until the pty is killed.
const TOTAL_BYTES = Number(process.env.WHIPHAND_BENCH_PTY_BYTES ?? 2_000_000);
let written = 0;
let n = 0;
function burst() {
  let chunk = '';
  while (chunk.length < 16_384) {
    n += 1;
    chunk += `\x1b[3${n % 7 + 1}m${String(n).padStart(6)}\x1b[0m ${'lorem ipsum dolor sit amet '.repeat(3)}\r\n`;
  }
  process.stdout.write(chunk);
  written += chunk.length;
  if (written < TOTAL_BYTES) setImmediate(burst);
  else process.stdout.write('\r\n[bench] done, idling\r\n');
}
burst();
setInterval(() => {}, 1 << 30);
