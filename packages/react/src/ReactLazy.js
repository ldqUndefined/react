/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Wakeable, Thenable} from 'shared/ReactTypes';

import {REACT_LAZY_TYPE} from 'shared/ReactSymbols';

const Uninitialized = -1; // 未初始化
const Pending = 0; // 加载中
const Resolved = 1; // 加载完成
const Rejected = 2; // 加载失败

// 下面是4种状态的类型
type UninitializedPayload<T> = {
  _status: -1,
  _result: () => Thenable<{default: T, ...}>,
};

type PendingPayload = {
  _status: 0,
  _result: Wakeable,
};

type ResolvedPayload<T> = {
  _status: 1,
  _result: T,
};

type RejectedPayload = {
  _status: 2,
  _result: mixed,
};
// lazy组件payload的类型
type Payload<T> =
  | UninitializedPayload<T>
  | PendingPayload
  | ResolvedPayload<T>
  | RejectedPayload;
// lazy组件的类型
export type LazyComponent<T, P> = {
  $$typeof: Symbol | number,
  _payload: P,
  _init: (payload: P) => T,
};

function lazyInitializer<T>(payload: Payload<T>): T {
  // lazy组件第一次执行时，状态为Uninitialized，会进入下面分支
  if (payload._status === Uninitialized) {
    // 状态为Uninitialized时，payload._result为动态import的函数
    const ctor = payload._result;
    // 直接执行该动态import函数获得相应的promise
    const thenable = ctor();
    // Transition to the next state.
    const pending: PendingPayload = (payload: any);
    // 执行了动态imoprt函数后，就已经发出请求了，所以将状态变为加载中
    pending._status = Pending;
    // 并将payload._result指向这个加载组件的promise
    pending._result = thenable;
    thenable.then(
      moduleObject => {
        // 当组件请求成功，且状态还是加载中时
        if (payload._status === Pending) {
          // 拿到文件的默认导出值
          const defaultExport = moduleObject.default;
          if (__DEV__) {
            if (defaultExport === undefined) {
              console.error(
                'lazy: Expected the result of a dynamic import() call. ' +
                  'Instead received: %s\n\nYour code should look like: \n  ' +
                  // Break up imports to avoid accidentally parsing them as dependencies.
                  'const MyComponent = lazy(() => imp' +
                  "ort('./MyComponent'))",
                moduleObject,
              );
            }
          }
          // Transition to the next state.
          const resolved: ResolvedPayload<T> = (payload: any);
          // 将lazy组件状态设置为加载完成
          resolved._status = Resolved;
          // 并把payload._result指向文件的默认导出
          resolved._result = defaultExport;
        }
      },
      error => {
        // 如果请求组件失败，且组件此时还是加载中时
        if (payload._status === Pending) {
          // Transition to the next state.
          const rejected: RejectedPayload = (payload: any);
          // 把组件标记为加载失败
          rejected._status = Rejected;
          // 病史payload._result指向报错内容
          rejected._result = error;
        }
      },
    );
  }
  if (payload._status === Resolved) {
    // 当lazy组件多次执行时，如果已经请求完成了，则直接返回组件
    return payload._result;
  } else {
    // 否则把payload._result当做错误抛出
    // lazy组件第一次执行时就会走到这个分支，将组件加载的promise抛出
    throw payload._result;
  }
}

export function lazy<T>(
  ctor: () => Thenable<{default: T, ...}>,
): LazyComponent<T, Payload<T>> {
  const payload: Payload<T> = {
    // We use these fields to store the result.
    _status: -1, // 初始状态为 未加载
    _result: ctor,
  };

  const lazyType: LazyComponent<T, Payload<T>> = {
    $$typeof: REACT_LAZY_TYPE,
    _payload: payload,
    _init: lazyInitializer,
  };

  if (__DEV__) {
    // In production, this would just set it on the object.
    let defaultProps;
    let propTypes;
    // $FlowFixMe
    Object.defineProperties(lazyType, {
      defaultProps: {
        configurable: true,
        get() {
          return defaultProps;
        },
        set(newDefaultProps) {
          console.error(
            'React.lazy(...): It is not supported to assign `defaultProps` to ' +
              'a lazy component import. Either specify them where the component ' +
              'is defined, or create a wrapping component around it.',
          );
          defaultProps = newDefaultProps;
          // Match production behavior more closely:
          // $FlowFixMe
          Object.defineProperty(lazyType, 'defaultProps', {
            enumerable: true,
          });
        },
      },
      propTypes: {
        configurable: true,
        get() {
          return propTypes;
        },
        set(newPropTypes) {
          console.error(
            'React.lazy(...): It is not supported to assign `propTypes` to ' +
              'a lazy component import. Either specify them where the component ' +
              'is defined, or create a wrapping component around it.',
          );
          propTypes = newPropTypes;
          // Match production behavior more closely:
          // $FlowFixMe
          Object.defineProperty(lazyType, 'propTypes', {
            enumerable: true,
          });
        },
      },
    });
  }

  return lazyType;
}
