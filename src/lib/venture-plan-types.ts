export interface VenturePlanStream {
  id: string;
  name: string;
  color: string;
  milestones: VentureMilestone[];
}

export interface VentureMilestone {
  month: number;
  target: string;
  revenue: number;
}

export interface VentureActual {
  date: string;      // ISO date
  stream: string;    // matches stream.id
  amount: number;
  note?: string;
}

export interface VenturePlan {
  startDate: string;
  targetMonthly: number;
  currency: string;
  streams: VenturePlanStream[];
  actuals: VentureActual[];
}
