/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactInternalTypes';

export type StackCursor<T> = {|current: T|};
// 用数组当栈用，valueStack[index]即栈顶
// 这里的设计十分神奇，整个react的内部共用一个栈，也就是所有和栈相关的操作，对于数据的压栈和出栈，都是在这个valueStack上操作的
// 而对于每个不同的功能模块，都会有一个自己的游标cursor，这个游标cursor对这个模块来说就是一个栈，但是这个cursor其实就是一个有current的对象
// 这个对象只存储了栈顶的内容，而在这个模块栈内的所有其他数据都存在了valueStack上。
const valueStack: Array<any> = [];

let fiberStack: Array<Fiber | null>;

if (__DEV__) {
  fiberStack = [];
}
// 当前栈顶的索引
let index = -1;
// 翻译成游标？创建一个游标，当成栈使用，其实就是一个对象，里面有个current指向当前栈顶的值
function createCursor<T>(defaultValue: T): StackCursor<T> {
  return {
    current: defaultValue,
  };
}

function isEmpty(): boolean {
  return index === -1;
}
// 出栈
function pop<T>(cursor: StackCursor<T>, fiber: Fiber): void {
  if (index < 0) {
    if (__DEV__) {
      console.error('Unexpected pop.');
    }
    return;
  }

  if (__DEV__) {
    if (fiber !== fiberStack[index]) {
      console.error('Unexpected Fiber popped.');
    }
  }
  // valueStack栈顶(最后一个元素)是cursor栈顶下的元素，也就是下一个栈顶
  cursor.current = valueStack[index];
  // 出栈实现就是把响应位置赋值为null
  valueStack[index] = null;

  if (__DEV__) {
    fiberStack[index] = null;
  }
  // 栈顶索引自减
  index--;
}
// 入栈
function push<T>(cursor: StackCursor<T>, value: T, fiber: Fiber): void {
  // 栈顶索引自增
  index++;
  // 把cursor当前值入栈
  valueStack[index] = cursor.current;

  if (__DEV__) {
    fiberStack[index] = fiber;
  }
  // cursor栈顶赋值
  cursor.current = value;
}

function checkThatStackIsEmpty() {
  if (__DEV__) {
    if (index !== -1) {
      console.error(
        'Expected an empty stack. Something was not reset properly.',
      );
    }
  }
}

function resetStackAfterFatalErrorInDev() {
  if (__DEV__) {
    index = -1;
    valueStack.length = 0;
    fiberStack.length = 0;
  }
}

export {
  createCursor,
  isEmpty,
  pop,
  push,
  // DEV only:
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
};
