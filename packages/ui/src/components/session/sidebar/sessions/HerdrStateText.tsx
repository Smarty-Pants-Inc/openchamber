import React from 'react';

/**
 * The Herdr state as part of a row button's accessible name (smarty-code#126 F4): the state dot beside the button is
 * not focusable, and a Herdr row shows no activity timer that would otherwise describe it.
 */
export const HerdrStateText: React.FC<{ label: string | null }> = ({ label }) => (
  label ? <span className="sr-only" data-herdr-state-text>{label}</span> : null
);
