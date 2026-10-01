// Prints N numbered lines to stdout (every tenth to stderr), as fast as the
// pipe takes them. Run by flood.yaml's command step; copied into the bench
// workspace beside it.
const count = Number(process.argv[2] ?? 50_000);
const pad = 'x'.repeat(60);
for (let i = 1; i <= count; i += 1) {
  const line = `line ${i} ${pad}\n`;
  if (i % 10 === 0) process.stderr.write(line);
  else if (!process.stdout.write(line)) await new Promise(resolve => process.stdout.once('drain', resolve));
}
