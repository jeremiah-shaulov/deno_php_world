import {PhpInterpreter} from './php_interpreter.ts';

export {PhpInterpreter, InterpreterError, InterpreterExitError, PhpSettings} from './php_interpreter.ts';
export type {PhpFpmSettings} from './php_interpreter.ts';

/**	Default instance of `PhpInterpreter` class for general purposes.
 **/
export const php = new PhpInterpreter;

/**	The same as `php.g`. For accessing remote global PHP objects, except classes (functions, variables, constants).
 **/
export const g = php.g;

/**	The same as `php.c`. For accessing remote PHP classes.
 **/
export const c = php.c;

/**	The same as `php.settings`. Modify settings before spawning interpreter or connecting to PHP-FPM service.
 **/
export const settings = php.settings;

export {ResponseWithCookies, ServerRequest} from './deps.ts';

export {start_proxy} from './php_fpm.ts';
export type {ProxyOptions} from './php_fpm.ts';
