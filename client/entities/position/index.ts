// Position entity (FSD)
// 포트폴리오 holdings / openOrders 관련 타입, selector, formatting 등을 이곳으로 이동 예정

// 현재는 shared에서 re-export (점진 이동)
export type { HoldingItem, Order } from '../../shared/types'

// TODO: buildPortfolioSummary, selectPositionBySymbol 등 selector 이동
// TODO: holdings 관련 포맷팅 로직 (mapPortfolio 등) 이동 고려
