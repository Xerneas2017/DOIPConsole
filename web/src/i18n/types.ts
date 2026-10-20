/**
 * i18n 字典类型（三语必须键集一致）。
 *
 * ★不引入 i18next：本项目只需要「静态 UI 文案 + 参数插值」，
 *   自研 40 行足够，且能保证打包体积不膨胀（目标 ≤ 50 MB 的延续）。
 */

import { zh } from './zh';

/** 全部可用文案 key（由中文基准字典推导） */
export type TKey = keyof typeof zh;

/** 某语言的完整字典（缺 key 会在编译期报错——这是防漏译的第一道闸） */
export type Dict = Record<TKey, string>;

export type Lang = 'zh' | 'en' | 'de';

export type TParams = Record<string, string | number>;

export type TFunc = (key: TKey, params?: TParams) => string;
