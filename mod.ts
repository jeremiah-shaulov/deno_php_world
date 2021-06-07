import {PhpInterpreter} from './php_interpreter.ts';

export {PhpInterpreter, InterpreterError, InterpreterExitError, Settings} from './php_interpreter.ts';

/**	Default instance of `PhpInterpreter` class for general purposes.
 **/
export const php = new PhpInterpreter;

export const {g, c, settings} = php;

export {ResponseWithCookies, ServerRequest} from './deps.ts';

export {start_proxy} from './php_fpm.ts';
export type {Options} from './php_fpm.ts';
