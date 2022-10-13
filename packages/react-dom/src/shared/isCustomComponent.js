/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
// 判断是否自定义组件的方法
function isCustomComponent(tagName: string, props: Object) {
  if (tagName.indexOf('-') === -1) {
    // 如果没有-，但是传了is为字符串，则是自定义组件
    return typeof props.is === 'string';
  }
  switch (tagName) {
    // These are reserved SVG and MathML elements.
    // We don't mind this list too much because we expect it to never grow.
    // The alternative is to track the namespace in a few places which is convoluted.
    // https://w3c.github.io/webcomponents/spec/custom/#custom-elements-core-concepts
    case 'annotation-xml':
    case 'color-profile':
    case 'font-face':
    case 'font-face-src':
    case 'font-face-uri':
    case 'font-face-format':
    case 'font-face-name':
    case 'missing-glyph':
    // 这几种是保留字段
      return false;
    default:
    // 否则都是自定义组件
      return true;
  }
}

export default isCustomComponent;
