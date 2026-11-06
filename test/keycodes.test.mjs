// 按键映射的回归测试。
// 重点只有一个：`Home`（编辑键，MOVE_HOME=122）和 `home`（回桌面按钮=3）是两码事。
// 拼错大小写就会变成"点一下退回桌面"，很难查。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

function table(name) {
  const start = source.indexOf('const ' + name + ' = {')
  assert.ok(start >= 0, '找不到 ' + name)
  const end = source.indexOf('}', start) + 1
  return source.slice(start, end)
}

const ctx = new Function(
  table('KEYCODES') + '\n' + table('EDIT_KEYCODES') + '\nreturn { KEYCODES, EDIT_KEYCODES }')()

test('编辑键码符合 Android KeyEvent 常量', () => {
  assert.deepEqual(ctx.EDIT_KEYCODES, {
    Backspace: 67, Delete: 112, Enter: 66, Tab: 61,
    ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22,
    Home: 122, End: 123,
  })
})

test('Home（编辑键）不能和 home（回桌面）混为一谈', () => {
  assert.equal(ctx.EDIT_KEYCODES.Home, 122)
  assert.equal(ctx.KEYCODES.home, 3)
  assert.notEqual(ctx.EDIT_KEYCODES.Home, ctx.KEYCODES.home)
})

test('actionKey 的查找顺序是先编辑键、再界面键', () => {
  assert.match(source, /const code = EDIT_KEYCODES\[name\] \|\| KEYCODES\[name\]/)
})

test('面板原有按键保持不变', () => {
  assert.equal(ctx.KEYCODES.back, 4)
  assert.equal(ctx.KEYCODES.volumeUp, 24)
  assert.equal(ctx.KEYCODES.volumeDown, 25)
  assert.equal(ctx.KEYCODES.power, 26)
})
