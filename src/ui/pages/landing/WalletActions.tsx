import { Link } from "react-router-dom";

export default function WalletActions() {
  return (
    <div className="wallet-actions">
      <Link to="/onboarding/create" className="bracket-button" aria-label="Create wallet">[ CREATE ]</Link>
      <Link to="/onboarding/restore" className="bracket-button" aria-label="Import wallet">[ IMPORT ]</Link>
    </div>
  );
}
