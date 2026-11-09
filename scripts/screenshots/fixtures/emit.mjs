// Canned step output for the demo runs (see runs/*.yaml): `node emit.mjs <step> <story>`.
// Prints line by line with short pauses so the runs have plausible durations,
// and exits 1 for the one story whose tests are meant to fail.
const [step, story] = process.argv.slice(2);
// Plain text: the desktop's log view shows a command step's output verbatim,
// so colour escapes would appear as raw `[32m` noise in the screenshot.
const green = s => s;
const red = s => s;
const dim = s => s;

const PLANS = {
  'checkout-flow': `# Plan: one-page checkout

## Context
Checkout is three pages today and loses a third of carts between the second and the third.
Collapse it into one page without changing the order API.

## Steps
1. Move address, delivery and payment into \`CheckoutPage\` as three collapsible sections.
2. Validate each section on blur; keep the submit button disabled until all three pass.
3. Keep \`checkout()\` in \`src/checkout.ts\` as the single place an order is created.
4. Redirect the old \`/checkout/address\` and \`/checkout/payment\` routes.

## Verify
- \`npm test\`
- Place an order end to end with the test card.
`,
};

const IMPLEMENT = [
  'Reading src/checkout.ts and src/cart.ts',
  'Edit src/checkout.ts: validate the cart before creating the order',
  'Edit src/pages/CheckoutPage.tsx: address, delivery and payment as sections',
  'Edit src/routes.ts: redirect the old checkout steps',
  'Done: 3 files changed, 142 insertions(+), 61 deletions(-)',
];

const TESTS_OK = [
  dim('> shop@1.0.0 test'),
  dim('> node --test'),
  '',
  `${green('✔')} cart totals round to cents ${dim('(1.2ms)')}`,
  `${green('✔')} an empty cart cannot be checked out ${dim('(0.4ms)')}`,
  `${green('✔')} checkout keeps the order API ${dim('(3.1ms)')}`,
  `${green('✔')} old checkout routes redirect ${dim('(0.8ms)')}`,
  '',
  `${green('ℹ tests 4')}  pass 4  fail 0`,
];

const TESTS_FAIL = [
  dim('> shop@1.0.0 test'),
  dim('> node --test'),
  '',
  `${green('✔')} an empty cart cannot be checked out ${dim('(0.4ms)')}`,
  `${red('✖')} cart totals round to cents ${dim('(1.9ms)')}`,
  '  AssertionError: Expected values to be strictly equal:',
  `  ${green('+ actual')} ${red('- expected')}`,
  `  ${green('+ 35.964')}`,
  `  ${red('- 3596')}`,
  '',
  `${red('ℹ tests 2')}  pass 1  fail 1`,
];

const REVIEW = `# Review

No blocking findings.

- \`checkout()\` still throws on an empty cart; the new page disables submit instead, so the
  error is now unreachable from the UI — keep it, it guards the API.
- The redirect for \`/checkout/payment\` drops the query string; harmless today.
`;

const LINKS = ['Checked 48 links in docs/', `${green('✔')} all links resolve`];
const REPRODUCE = [`${red('✖')} flaky: 3 failures in 50 runs of 'login keeps the session'`, 'Seed 1734 reproduces it every time'];

const out = {
  plan: PLANS[story] ?? PLANS['checkout-flow'],
  implement: IMPLEMENT.join("\n"),
  tests: story === 'cart-rounding' ? TESTS_FAIL : TESTS_OK,
  review: REVIEW,
  links: LINKS,
  reproduce: REPRODUCE,
}[step];
if (out === undefined) throw new Error(`emit.mjs: no output for step '${step}'`);

// Markdown goes straight into the run dir, as an agent's artifact would: a
// command step's `output:` file starts with its command line and a header.
if (typeof out === 'string') {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(process.env.WHIPHAND_RUN_DIR, `${step}.md`), out);
}

const lines = Array.isArray(out) ? out : out.split('\n');
for (const line of lines) {
  process.stdout.write(`${line}\n`);
  await new Promise(resolve => setTimeout(resolve, 60));
}
if (step === 'tests' && story === 'cart-rounding') process.exitCode = 1;
