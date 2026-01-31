import { ethers } from 'ethers';
import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const D = (v) => new Decimal(v.toString());

const Q96 = D(2).pow(96);

/* ================= 全局内存缓存 ================= */
const GLOBAL_CACHE = {
  tokens: {}, 
  pools: {},  
  positionStatic: {} 
};

/* ================= 配置 ================= */

export const CHAINS = {
  bsc: {
    rpc: 'https://bsc-dataseed.binance.org',
    pancake: {
      positionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
      factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
    },
    uniswap: {
      positionManager: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
      factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7'
    }
  }
};

export const STABLES = [
  '0x55d398326f99059ff775485246999027b3197955', // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'  // USDC
].map(a => a.toLowerCase());

/* ================= ABI ================= */

const POSITION_ABI = [
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256) view returns (address)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)'
];

const FACTORY_ABI = [
  'function getPool(address,address,uint24) view returns (address)'
];

const POOL_ABI = [
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'
];

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

/* ================= 工具函数 ================= */

function tickToSqrtPrice(tick) {
  return D('1.0001').pow(D(tick).div(2));
}

function identifyStable(token0, token1) {
  const t0 = STABLES.includes(token0.toLowerCase());
  const t1 = STABLES.includes(token1.toLowerCase());
  if (t0 && !t1) return { stable: 0, volatile: 1 };
  if (t1 && !t0) return { stable: 1, volatile: 0 };
  return { stable: 0, volatile: 1, warning: 'No stablecoin identified' };
}

async function getTokenMetaWithCache(provider, addr) {
  const key = addr.toLowerCase();
  if (GLOBAL_CACHE.tokens[key]) return GLOBAL_CACHE.tokens[key];
  const c = new ethers.Contract(addr, ERC20_ABI, provider);
  const [decimals, symbol] = await Promise.all([c.decimals(), c.symbol()]);
  const meta = { decimals, symbol };
  GLOBAL_CACHE.tokens[key] = meta; 
  return meta;
}

async function getPoolAddressWithCache(provider, factoryAddr, token0, token1, fee) {
  const key = `${factoryAddr}-${token0}-${token1}-${fee}`.toLowerCase();
  if (GLOBAL_CACHE.pools[key]) return GLOBAL_CACHE.pools[key];
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const poolAddr = await factory.getPool(token0, token1, fee);
  GLOBAL_CACHE.pools[key] = poolAddr; 
  return poolAddr;
}

/* ================= 主函数 ================= */

let _cachedProvider = null;

export async function analyzeV3Position({
  chain,
  protocol,
  tokenId,
  costUsd = null,
  externalProvider = null
}) {
  const cfg = CHAINS[chain]?.[protocol];
  if (!cfg) throw new Error('Unsupported chain/protocol');

  const provider = externalProvider || _cachedProvider || new ethers.JsonRpcProvider(CHAINS[chain].rpc);
  if (!_cachedProvider) _cachedProvider = provider;

  /* ---------- 步骤 A: 获取核心动态数据 ---------- */
  
  const pm = new ethers.Contract(cfg.positionManager, POSITION_ABI, provider);
  
  const [posResult, owner] = await Promise.all([
    pm.positions(tokenId),
    pm.ownerOf(tokenId)
  ]);

  const token0Addr = posResult.token0;
  const token1Addr = posResult.token1;
  const fee = posResult.fee;
  
  const liquidity = D(posResult.liquidity.toString());
  const tickLower = Number(posResult.tickLower);
  const tickUpper = Number(posResult.tickUpper);

  /* ---------- 步骤 B: 智能获取静态配置 ---------- */
  
  const poolAddr = await getPoolAddressWithCache(provider, cfg.factory, token0Addr, token1Addr, fee);
  
  const [meta0, meta1] = await Promise.all([
    getTokenMetaWithCache(provider, token0Addr),
    getTokenMetaWithCache(provider, token1Addr)
  ]);

  /* ---------- 步骤 C: 获取实时市场数据 & 模拟收益 ---------- */
  
  const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
  const MAX_UINT128 = D(2).pow(128).minus(1).toFixed(0);

  const [slot0, collectResult] = await Promise.all([
    pool.slot0(),
    pm.collect.staticCall({
      tokenId: tokenId,
      recipient: owner,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128
    })
  ]);

  /* ---------- 步骤 D: 数学计算 (无网络请求) ---------- */

  const currentTick = Number(slot0[1]);
  const sqrtP = D(slot0[0].toString()).div(Q96);
  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  const TEN0 = D(10).pow(meta0.decimals);
  const TEN1 = D(10).pow(meta1.decimals);
  const decimalShift = TEN0.div(TEN1); // 用于修正价格精度的因子

  // --- 1. 计算区间价格 (Min/Max Price) [新增部分] ---

  // 计算原始 Tick 对应的 SqrtPrice
  const sqrtPL = tickToSqrtPrice(tickLower);
  const sqrtPU = tickToSqrtPrice(tickUpper);

  // 转换为 Token1/Token0 的数学价格，并根据精度修正
  // 注意：UniV3 数学价格 = price * (10^dec1 / 10^dec0)，所以我们还原时要乘 (10^dec0 / 10^dec1)
  const priceLowMath = sqrtPL.pow(2).mul(TEN0).div(TEN1);
  const priceUpMath = sqrtPU.pow(2).mul(TEN0).div(TEN1);

  const { stable, volatile } = identifyStable(token0Addr, token1Addr);

  let minPrice, maxPrice;

  if (stable === 0) {
    // 场景：Token0 是 USDT，Token1 是 BNB。
    // MathPrice 是 BNB/USDT (例如 0.003)。
    // 人类习惯看 USDT/BNB (例如 300)。
    // 所以我们需要取倒数 (1/price)。
    // 取倒数后，原本的 tickUpper 变成了数值上的最小值，tickLower 变成了最大值。
    minPrice = D(1).div(priceUpMath);
    maxPrice = D(1).div(priceLowMath);
  } else {
    // 场景：Token1 是 USDT，Token0 是 BNB。
    // MathPrice 是 USDT/BNB (例如 300)。
    // 这符合人类直觉，不需要倒数。
    minPrice = priceLowMath;
    maxPrice = priceUpMath;
  }

  // --- 2. 计算本金 ---
  
  let amt0 = D(0), amt1 = D(0);
  if (currentTick <= tickLower) {
    amt0 = liquidity.mul(sqrtPU.minus(sqrtPL)).div(sqrtPU.mul(sqrtPL));
  } else if (currentTick >= tickUpper) {
    amt1 = liquidity.mul(sqrtPU.minus(sqrtPL));
  } else {
    amt0 = liquidity.mul(sqrtPU.minus(sqrtP)).div(sqrtPU.mul(sqrtP));
    amt1 = liquidity.mul(sqrtP.minus(sqrtPL));
  }
  
  const principal0 = amt0.div(TEN0);
  const principal1 = amt1.div(TEN1);

  // --- 3. 计算手续费 ---
  
  const fee0 = D(collectResult[0].toString()).div(TEN0);
  const fee1 = D(collectResult[1].toString()).div(TEN1);

  // --- 4. 计算总价值 (USD) ---

  const priceToken1InToken0 = sqrtP.pow(2);
  const priceVolatileUsd = stable === 0 
    ? D(1).div(priceToken1InToken0).mul(TEN1).div(TEN0) // 同样修正精度
    : priceToken1InToken0.mul(TEN0).div(TEN1);

  const stablePrincipal = stable === 0 ? principal0 : principal1;
  const volatilePrincipal = volatile === 0 ? principal0 : principal1;
  const stableFee = stable === 0 ? fee0 : fee1;
  const volatileFee = volatile === 0 ? fee0 : fee1;

  const totalUsd = stablePrincipal
    .plus(stableFee)
    .plus(volatilePrincipal.plus(volatileFee).mul(priceVolatileUsd));

  const feeUsd = stableFee.plus(volatileFee.mul(priceVolatileUsd));

  let pnl = null, roi = null;
  if (costUsd !== null) {
    pnl = totalUsd.minus(D(costUsd));
    roi = pnl.div(D(costUsd)).mul(100);
  }

  return {
    tokenId,
    pool: poolAddr,
    priceUsd: priceVolatileUsd.toFixed(6),
    inRange,
    
    range: {
      minPrice: minPrice.toFixed(6),
      maxPrice: maxPrice.toFixed(6)
    },

    holdings: {
      stableSymbol: stable === 0 ? meta0.symbol : meta1.symbol,
      volatileSymbol: volatile === 0 ? meta0.symbol : meta1.symbol,

      liquidity: {
        stable: stablePrincipal.toFixed(8),
        volatile: volatilePrincipal.toFixed(8)
      },

      fees: {
        stable: stableFee.toFixed(8),
        volatile: volatileFee.toFixed(8),
        feeValueUsd: feeUsd.toFixed(8)
      }
    },

    totalValueUsd: totalUsd.toFixed(8),
    pnlUsd: pnl?.toFixed(8),
    roiPercent: roi?.toFixed(4)
  };
}