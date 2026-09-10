import React from 'react';
import { useI18n } from '@/lib/i18n';
import { PRODUCT_MARK } from '@/lib/brand.generated';
import { cn } from '@/lib/utils';

interface OpenChamberLogoProps {
  className?: string;
  width?: number;
  height?: number;
  isAnimated?: boolean;
}

export const OpenChamberLogo: React.FC<OpenChamberLogoProps> = ({
  className,
  width = 70,
  height = 70,
  isAnimated = false,
}) => {
  const { t } = useI18n();

  return (
    <span
      role="img"
      aria-label={t('openChamberLogo.aria.logo')}
      className={cn('inline-flex shrink-0 items-center justify-center', isAnimated && 'motion-safe:animate-pulse', className)}
      style={{ width, height, fontSize: Math.min(width, height) * 0.88, lineHeight: 1 }}
    >
      {PRODUCT_MARK}
    </span>
  );
};
