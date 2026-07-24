import type { ReactNode } from 'react';
import { Flex, Typography } from '@strapi/design-system';

export interface SectionHeadingProps {
  title: ReactNode;
  description: ReactNode;
  titleAdornment?: ReactNode;
}

/**
 * Strapi-style section heading with a semantic title and supporting copy.
 */
export const SectionHeading = ({ title, description, titleAdornment }: SectionHeadingProps) => (
  <Flex direction="column" alignItems="stretch" gap={1}>
    {titleAdornment ? (
      <Flex gap={2} alignItems="center">
        <Typography variant="delta" tag="h2">
          {title}
        </Typography>
        {titleAdornment}
      </Flex>
    ) : (
      <Typography variant="delta" tag="h2">
        {title}
      </Typography>
    )}
    <Typography variant="pi" tag="p" textColor="neutral600">
      {description}
    </Typography>
  </Flex>
);
