import { Link, useSearchParams } from 'react-router-dom';
import { BacktestPanel } from '../../widgets/BacktestPanel';

export function BacktestPage() {
  const [params] = useSearchParams();
  const symbol = params.get('symbol') ?? 'AAPL';

  return (
    <main className="backtest-page">
      <div className="backtest-head">
        <h1>신호 백테스트</h1>
        <Link to="/" className="backtest-back">
          ← 트레이딩으로
        </Link>
      </div>

      <p className="hint backtest-intro">
        차트 신호(강매수~강매도)를 과거 캔들에 "그 시점 데이터만으로" 재계산하고, 이후 결과를 라벨링해
        적중률·기대값을 봅니다. 결과는 과거 통계일 뿐 미래를 보장하지 않으며, 매매 권유가 아닙니다.
      </p>

      <BacktestPanel key={symbol} initialSymbol={symbol} />
    </main>
  );
}
