import { describe, expect, it } from 'vitest';
import { checkShellOperators } from '../../src/tools/execHelpers';

const allowed = (args: string[]): void => expect(() => checkShellOperators(args)).not.toThrow();
const refused = (args: string[]): void =>
  expect(() => checkShellOperators(args)).toThrow('Shell operators are not permitted');

describe('checkShellOperators', () => {
  it('still refuses a shell line handed over as argv', () => {
    // The real mistake: the model wrote a shell command and split it into args.
    refused(['-e', 'console.log(1)', '&&', 'node', '-e', 'console.log(2)']);
    refused(['build', '||', 'true']);
    refused(['a', '|', 'grep', 'x']);
    refused(['out', '>', 'file.txt']);
    refused(['a', ';', 'b']);
    refused(['cmd', '2>&1']);
  });

  it('no longer refuses operator characters INSIDE an argument', () => {
    // spawn runs with shell: false, so these reach the program verbatim and no
    // shell ever sees them. Substring matching blocked most node one-liners:
    // this exact script was refused for containing ";" and "<".
    allowed(['-e', "for(let i=0;i<50;i++)console.log('line '+i)"]);
    allowed(['-e', 'const f = (a) => a > 1;']);
    allowed(['-e', 'if (a && b) console.log(1)']);
    allowed(['-e', 'console.log(`template ${x}`)']);
    allowed(['--filter', 'a|b']);
    allowed(['-e', 'process.stdout.write("2>&1 is not an operator here")']);
  });

  it('ignores surrounding whitespace when deciding', () => {
    refused(['&& ']);
    refused([' ;']);
  });

  it('names the offending token so the model can fix it', () => {
    expect(() => checkShellOperators(['a', '&&', 'b'])).toThrow('"&&"');
  });
});
