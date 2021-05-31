import {PhpInterpreter} from './php_interpreter.ts';

export {PhpInterpreter, InterpreterError, InterpreterExitError} from './php_interpreter.ts';
export const php = new PhpInterpreter;
export const {g, c, settings} = php;
