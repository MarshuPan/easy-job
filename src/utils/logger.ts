/**
 * 页面脚本常常改写 window.console 来吞掉或污染日志，BOSS 的页面也不例外。
 * 从一个空 iframe 里取 console，拿到的是没被页面碰过的那一份。
 */

const icons = { debug: '🐞', info: 'ℹ️', warn: '⚠', error: '❌️' }
const Color = {
  debug: '#42CA8C;',
  info: '#37C5D6;',
  warn: '#EFC441;',
  error: '#FF6257;',
}

function getCleanConsole() {
  const iframe = document.createElement('iframe')
  iframe.style.display = 'none'
  document.head.appendChild(iframe)
  const cleanConsole = iframe.contentWindow?.console as Console
  // iframe 不能移除：拿到的 console 属于它的 window，移除后引用即失效。
  return cleanConsole
}
enum LogLevel {
  DEBUG = 8,
  INFO = 4,
  WARN = 2,
  ERROR = 1,
}

function getLogLevel() {
  if ('localStorage' in window) {
    const temp = localStorage.getItem('__EASY_JOB_LOG_LEVEL__')
    if (temp) {
      switch (temp.toLowerCase()) {
        case 'debug':
          return LogLevel.DEBUG
        case 'info':
          return LogLevel.INFO
        case 'warn':
          return LogLevel.WARN
        case 'error':
          return LogLevel.ERROR
      }
    }
  }
  return LogLevel.INFO
}

const newConsole = getCleanConsole()
const logLevel = getLogLevel()

export const logger = {
  log: newConsole.log.bind(
    newConsole,
    `%c${icons.info} log > `,
    `color:${Color.info}; padding-left:1.2em; line-height:1.5em;`,
  ),
  debug:
    logLevel >= LogLevel.DEBUG
      ? newConsole.log.bind(
          newConsole,
          `%c${icons.debug} debug > `,
          `color:${Color.debug}; padding-left:1.2em; line-height:1.5em;`,
        )
      : () => {},
  info:
    logLevel >= LogLevel.INFO
      ? newConsole.info.bind(
          newConsole,
          `%c${icons.info} info > `,
          `color:${Color.info}; padding-left:1.2em; line-height:1.5em;`,
        )
      : () => {},
  warn:
    logLevel >= LogLevel.WARN
      ? newConsole.warn.bind(
          newConsole,
          `%c${icons.warn} warn > `,
          `color:${Color.warn}; padding-left:1.2em; line-height:1.5em;`,
        )
      : () => {},
  error: newConsole.error.bind(
    newConsole,
    `%c${icons.error} error > `,
    `color:${Color.error}; padding-left:1.2em; line-height:1.5em;`,
  ),
  group: newConsole.groupCollapsed,
  groupEnd: newConsole.groupEnd,
}
