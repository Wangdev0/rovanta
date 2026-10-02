/**
 * Interfaces for a future execution layer.
 *
 * ROVANTA is read-only. Nothing in this build signs, simulates or submits
 * transactions. These types document the boundary an audited implementation
 * would have to fit; they have no implementations.
 */

export type Hex = `0x${string}`;

export interface UnsignedTransaction {
  chainId: number;
  to: Hex;
  data?: Hex;
  /** Wei, as a decimal string. */
  value?: string;
  gasLimit?: string;
  nonce?: number;
}

export type PermissionScope =
  | { kind: "read_address"; chainId: number }
  | { kind: "simulate"; chainId: number }
  | {
      kind: "sign_transaction";
      chainId: number;
      to: Hex;
      /** Upper bound for the native value, wei as a decimal string. */
      maxValue: string;
      expiresAt: string;
    };

export type PermissionDecision =
  | { granted: true; scope: PermissionScope; grantedAt: string }
  | { granted: false; scope: PermissionScope; reason: string };

export interface PermissionManager {
  /** Must require an explicit user action; never auto-granted by a model. */
  requestPermission(scope: PermissionScope): Promise<PermissionDecision>;
  check(scope: PermissionScope): Promise<PermissionDecision>;
}

export interface WalletProvider {
  getAddress(): Promise<Hex>;
  /** Optional: a watch-only wallet cannot sign. */
  signTransaction?(tx: UnsignedTransaction): Promise<Hex>;
}

export interface SimulationResult {
  success: boolean;
  gasUsed: string | null;
  revertReason: string | null;
  /** Human-readable state changes (balances, approvals) reported by the simulator. */
  effects: string[];
  warnings: string[];
}

export interface TransactionSimulator {
  simulate(tx: UnsignedTransaction): Promise<SimulationResult>;
}

export interface ExecutionRequest {
  id: string;
  transaction: UnsignedTransaction;
  /** Why the transaction is proposed, shown to the user before any permission prompt. */
  rationale: string;
  requiredScope: PermissionScope;
  createdAt: string;
}

export type ExecutionStatus = "proposed" | "simulated" | "approved" | "rejected" | "submitted" | "failed";

export interface ExecutionRecord {
  request: ExecutionRequest;
  status: ExecutionStatus;
  simulation?: SimulationResult;
  txHash?: Hex;
  error?: string;
}

export interface ExecutionLayer {
  wallet: WalletProvider;
  permissions: PermissionManager;
  simulator: TransactionSimulator;
}
