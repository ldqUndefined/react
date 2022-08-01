/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactInternalTypes';
import type {FiberRoot} from './ReactInternalTypes';
import type {Lane, Lanes} from './ReactFiberLane';
import type {CapturedValue} from './ReactCapturedValue';
import type {Update} from './ReactUpdateQueue.old';
import type {Wakeable} from 'shared/ReactTypes';
import type {SuspenseContext} from './ReactFiberSuspenseContext.old';

import getComponentName from 'shared/getComponentName';
import {
  ClassComponent,
  HostRoot,
  SuspenseComponent,
  IncompleteClassComponent,
} from './ReactWorkTags';
import {
  DidCapture,
  Incomplete,
  NoFlags,
  ShouldCapture,
  LifecycleEffectMask,
  ForceUpdateForLegacySuspense,
} from './ReactFiberFlags';
import {shouldCaptureSuspense} from './ReactFiberSuspenseComponent.old';
import {NoMode, BlockingMode, DebugTracingMode} from './ReactTypeOfMode';
import {
  enableDebugTracing,
  enableSchedulingProfiler,
} from 'shared/ReactFeatureFlags';
import {createCapturedValue} from './ReactCapturedValue';
import {
  enqueueCapturedUpdate,
  createUpdate,
  CaptureUpdate,
  ForceUpdate,
  enqueueUpdate,
} from './ReactUpdateQueue.old';
import {markFailedErrorBoundaryForHotReloading} from './ReactFiberHotReloading.old';
import {
  suspenseStackCursor,
  InvisibleParentSuspenseContext,
  hasSuspenseContext,
} from './ReactFiberSuspenseContext.old';
import {
  renderDidError,
  onUncaughtError,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  pingSuspendedRoot,
} from './ReactFiberWorkLoop.old';
import {logCapturedError} from './ReactFiberErrorLogger';
import {logComponentSuspended} from './DebugTracing';
import {markComponentSuspended} from './SchedulingProfiler';

import {
  SyncLane,
  NoTimestamp,
  includesSomeLane,
  mergeLanes,
  pickArbitraryLane,
} from './ReactFiberLane';
// 如果浏览器支持就用weakMap，否则就降级成Map
const PossiblyWeakMap = typeof WeakMap === 'function' ? WeakMap : Map;
// 创建一个hostRoot的捕获到错误的更新
function createRootErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  lane: Lane,
): Update<mixed> {
  const update = createUpdate(NoTimestamp, lane);
  // Unmount the root by rendering null.
  // 更新的类型为 捕获错误导致的更新
  update.tag = CaptureUpdate;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  // 更新的内容为：子节点为null
  update.payload = {element: null};
  const error = errorInfo.value;
  update.callback = () => {
    onUncaughtError(error);
    logCapturedError(fiber, errorInfo);
  };
  return update;
}
// 类组件捕获错误的更新
function createClassErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  lane: Lane,
): Update<mixed> {
  const update = createUpdate(NoTimestamp, lane);
  // 更新的类型为 捕获错误导致的更新
  update.tag = CaptureUpdate;
  const getDerivedStateFromError = fiber.type.getDerivedStateFromError;
  if (typeof getDerivedStateFromError === 'function') {
    // 如果实现了getDerivedStateFromError，那么更新执行的回调就是getDerivedStateFromError
    const error = errorInfo.value;
    update.payload = () => {
      logCapturedError(fiber, errorInfo);
      return getDerivedStateFromError(error);
    };
  }

  const inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    // 如果实现了componentDidCatch
    // 则更新的回调为下面的函数
    update.callback = function callback() {
      if (__DEV__) {
        markFailedErrorBoundaryForHotReloading(fiber);
      }
      if (typeof getDerivedStateFromError !== 'function') {
        // To preserve the preexisting retry behavior of error boundaries,
        // we keep track of which ones already failed during this batch.
        // This gets reset before we yield back to the browser.
        // TODO: Warn in strict mode if getDerivedStateFromError is
        // not defined.
        // 如果没实现getDerivedStateFromError，标记为fail
        markLegacyErrorBoundaryAsFailed(this);

        // Only log here if componentDidCatch is the only error boundary method defined
        logCapturedError(fiber, errorInfo);
      }
      const error = errorInfo.value;
      const stack = errorInfo.stack;
      // 执行componentDidCatch，可以拿到错误和执行栈
      this.componentDidCatch(error, {
        componentStack: stack !== null ? stack : '',
      });
      if (__DEV__) {
        if (typeof getDerivedStateFromError !== 'function') {
          // If componentDidCatch is the only error boundary method defined,
          // then it needs to call setState to recover from errors.
          // If no state update is scheduled then the boundary will swallow the error.
          // 没有实现getDerivedStateFromError的话会警告
          if (!includesSomeLane(fiber.lanes, (SyncLane: Lane))) {
            console.error(
              '%s: Error boundaries should implement getDerivedStateFromError(). ' +
                'In that method, return a state update to display an error message or fallback UI.',
              getComponentName(fiber.type) || 'Unknown',
            );
          }
        }
      }
    };
  } else if (__DEV__) {
    update.callback = () => {
      markFailedErrorBoundaryForHotReloading(fiber);
    };
  }
  return update;
}

function attachPingListener(root: FiberRoot, wakeable: Wakeable, lanes: Lanes) {
  // Attach a listener to the promise to "ping" the root and retry. But only if
  // one does not already exist for the lanes we're currently rendering (which
  // acts like a "thread ID" here).
  let pingCache = root.pingCache;
  let threadIDs;
  if (pingCache === null) {
    pingCache = root.pingCache = new PossiblyWeakMap();
    threadIDs = new Set();
    pingCache.set(wakeable, threadIDs);
  } else {
    threadIDs = pingCache.get(wakeable);
    if (threadIDs === undefined) {
      threadIDs = new Set();
      pingCache.set(wakeable, threadIDs);
    }
  }
  if (!threadIDs.has(lanes)) {
    // Memoize using the thread ID to prevent redundant listeners.
    threadIDs.add(lanes);
    const ping = pingSuspendedRoot.bind(null, root, wakeable, lanes);
    wakeable.then(ping, ping);
  }
}
// 向上查找是否有能够处理错误的fiber节点
function throwException(
  root: FiberRoot,
  returnFiber: Fiber,
  sourceFiber: Fiber,
  value: mixed,
  rootRenderLanes: Lanes,
) {
  // The source fiber did not complete.
  // 把抛出错误的节点标记为 未完成
  sourceFiber.flags |= Incomplete;
  // Its effect list is no longer valid.
  // 并且因为出错了，所以清空副作用链表，避免错误执行
  sourceFiber.firstEffect = sourceFiber.lastEffect = null;

  // 下面是React.lazy运行时会抛出promise的条件分支
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.then === 'function'
  ) {
    // This is a wakeable.
    const wakeable: Wakeable = (value: any);

    if (__DEV__) {
      if (enableDebugTracing) {
        if (sourceFiber.mode & DebugTracingMode) {
          const name = getComponentName(sourceFiber.type) || 'Unknown';
          logComponentSuspended(name, wakeable);
        }
      }
    }

    if (enableSchedulingProfiler) {
      markComponentSuspended(sourceFiber, wakeable);
    }

    if ((sourceFiber.mode & BlockingMode) === NoMode) {
      // Reset the memoizedState to what it was before we attempted
      // to render it.
      const currentSource = sourceFiber.alternate;
      if (currentSource) {
        sourceFiber.updateQueue = currentSource.updateQueue;
        sourceFiber.memoizedState = currentSource.memoizedState;
        sourceFiber.lanes = currentSource.lanes;
      } else {
        sourceFiber.updateQueue = null;
        sourceFiber.memoizedState = null;
      }
    }

    const hasInvisibleParentBoundary = hasSuspenseContext(
      suspenseStackCursor.current,
      (InvisibleParentSuspenseContext: SuspenseContext),
    );

    // Schedule the nearest Suspense to re-render the timed out view.
    let workInProgress = returnFiber;
    // 向上找到一个能处理该promise的Suspense组件
    do {
      if (
        workInProgress.tag === SuspenseComponent &&
        shouldCaptureSuspense(workInProgress, hasInvisibleParentBoundary)
      ) {
        // Found the nearest boundary.

        // Stash the promise on the boundary fiber. If the boundary times out, we'll
        // attach another listener to flip the boundary back to its normal state.
        // SuspenseComponent的updateQueue是一个set，里面放着promise
        const wakeables: Set<Wakeable> = (workInProgress.updateQueue: any);
        if (wakeables === null) {
          const updateQueue = (new Set(): any);
          updateQueue.add(wakeable);
          workInProgress.updateQueue = updateQueue;
        } else {
          wakeables.add(wakeable);
        }

        // If the boundary is outside of blocking mode, we should *not*
        // suspend the commit. Pretend as if the suspended component rendered
        // null and keep rendering. In the commit phase, we'll schedule a
        // subsequent synchronous update to re-render the Suspense.
        //
        // Note: It doesn't matter whether the component that suspended was
        // inside a blocking mode tree. If the Suspense is outside of it, we
        // should *not* suspend the commit.
        if ((workInProgress.mode & BlockingMode) === NoMode) {
          workInProgress.flags |= DidCapture;
          sourceFiber.flags |= ForceUpdateForLegacySuspense;

          // We're going to commit this fiber even though it didn't complete.
          // But we shouldn't call any lifecycle methods or callbacks. Remove
          // all lifecycle effect tags.
          sourceFiber.flags &= ~(LifecycleEffectMask | Incomplete);

          if (sourceFiber.tag === ClassComponent) {
            const currentSourceFiber = sourceFiber.alternate;
            if (currentSourceFiber === null) {
              // This is a new mount. Change the tag so it's not mistaken for a
              // completed class component. For example, we should not call
              // componentWillUnmount if it is deleted.
              sourceFiber.tag = IncompleteClassComponent;
            } else {
              // When we try rendering again, we should not reuse the current fiber,
              // since it's known to be in an inconsistent state. Use a force update to
              // prevent a bail out.
              const update = createUpdate(NoTimestamp, SyncLane);
              update.tag = ForceUpdate;
              enqueueUpdate(sourceFiber, update);
            }
          }

          // The source fiber did not complete. Mark it with Sync priority to
          // indicate that it still has pending work.
          sourceFiber.lanes = mergeLanes(sourceFiber.lanes, SyncLane);

          // Exit without suspending.
          return;
        }

        // Confirmed that the boundary is in a concurrent mode tree. Continue
        // with the normal suspend path.
        //
        // After this we'll use a set of heuristics to determine whether this
        // render pass will run to completion or restart or "suspend" the commit.
        // The actual logic for this is spread out in different places.
        //
        // This first principle is that if we're going to suspend when we complete
        // a root, then we should also restart if we get an update or ping that
        // might unsuspend it, and vice versa. The only reason to suspend is
        // because you think you might want to restart before committing. However,
        // it doesn't make sense to restart only while in the period we're suspended.
        //
        // Restarting too aggressively is also not good because it starves out any
        // intermediate loading state. So we use heuristics to determine when.

        // Suspense Heuristics
        //
        // If nothing threw a Promise or all the same fallbacks are already showing,
        // then don't suspend/restart.
        //
        // If this is an initial render of a new tree of Suspense boundaries and
        // those trigger a fallback, then don't suspend/restart. We want to ensure
        // that we can show the initial loading state as quickly as possible.
        //
        // If we hit a "Delayed" case, such as when we'd switch from content back into
        // a fallback, then we should always suspend/restart. Transitions apply
        // to this case. If none is defined, JND is used instead.
        //
        // If we're already showing a fallback and it gets "retried", allowing us to show
        // another level, but there's still an inner boundary that would show a fallback,
        // then we suspend/restart for 500ms since the last time we showed a fallback
        // anywhere in the tree. This effectively throttles progressive loading into a
        // consistent train of commits. This also gives us an opportunity to restart to
        // get to the completed state slightly earlier.
        //
        // If there's ambiguity due to batching it's resolved in preference of:
        // 1) "delayed", 2) "initial render", 3) "retry".
        //
        // We want to ensure that a "busy" state doesn't get force committed. We want to
        // ensure that new initial loading states can commit as soon as possible.

        attachPingListener(root, wakeable, rootRenderLanes);

        workInProgress.flags |= ShouldCapture;
        workInProgress.lanes = rootRenderLanes;

        return;
      }
      // This boundary already captured during this render. Continue to the next
      // boundary.
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);
    // No boundary was found. Fallthrough to error mode.
    // TODO: Use invariant so the message is stripped in prod?
    value = new Error(
      (getComponentName(sourceFiber.type) || 'A React component') +
        ' suspended while rendering, but no fallback UI was specified.\n' +
        '\n' +
        'Add a <Suspense fallback=...> component higher in the tree to ' +
        'provide a loading indicator or placeholder to display.',
    );
  }

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.
  // 标记渲染错误
  renderDidError();
  // 构造错误对象
  value = createCapturedValue(value, sourceFiber);
  let workInProgress = returnFiber;
  // 通过这个循环向上找是否有能够处理错误的Error Boundary
  // 如果找不到就会命中HostRoot的分支，会调度一个子节点为null的渲染，即白屏
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        // 没有能处理错误的Error Boundary，调度一个白屏渲染
        const errorInfo = value;
        // 将HostRoot标记为需要捕获错误的节点
        workInProgress.flags |= ShouldCapture;
        const lane = pickArbitraryLane(rootRenderLanes);
        workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
        // 创建一个hostRoot捕获到错误的更新
        const update = createRootErrorUpdate(workInProgress, errorInfo, lane);
        // 捕获错误更新专用的入队函数
        enqueueCapturedUpdate(workInProgress, update);
        // 结束向上寻找
        return;
      }
      case ClassComponent:
        // Capture and retry
        const errorInfo = value;
        const ctor = workInProgress.type;
        const instance = workInProgress.stateNode;
        // 判断这个类组件是否实现了getDerivedStateFromError或componentDidCatch，以及是否在本次渲染中已经捕获过错误了
        if (
          (workInProgress.flags & DidCapture) === NoFlags &&
          (typeof ctor.getDerivedStateFromError === 'function' ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          // 将这个类组件标记为 应该捕获错误
          workInProgress.flags |= ShouldCapture;
          const lane = pickArbitraryLane(rootRenderLanes);
          // 添加更新优先级
          workInProgress.lanes = mergeLanes(workInProgress.lanes, lane);
          // Schedule the error boundary to re-render using updated state
          // 创建一个类组件捕获了错误的更新
          const update = createClassErrorUpdate(
            workInProgress,
            errorInfo,
            lane,
          );
          // 捕获错误更新专用的入队函数
          enqueueCapturedUpdate(workInProgress, update);
          // 结束向上寻找
          return;
        }
        break;
      default:
        break;
    }
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);
}

export {throwException, createRootErrorUpdate, createClassErrorUpdate};
