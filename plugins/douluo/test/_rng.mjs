/**
 * 测试用确定性随机数
 * ==================
 *
 * 引擎里不少判定默认走 Math.random（暴击 / 掉落 / 战斗回合），直接拿它
 * 跑断言会让同一份代码在不同时刻得出不同结论——CI 偶发红就是这么来的。
 * 这里复用引擎自己的 mulberry32，把全局 Math.random 换成固定种子序列。
 *
 * 只在测试进程里替换，退出时还原，不影响插件运行时。
 */
import { makeRng } from '../src/engine/balance.js';

const original = Math.random;
const rng = makeRng(0x20261122);
Math.random = rng;
process.on('exit', () => { Math.random = original; });
