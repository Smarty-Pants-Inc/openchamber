"use client"

import { isValidElement } from "react"
import { toast as sonnerToast } from "sonner"
import type { ExternalToast } from "sonner"
import { copyTextToClipboard } from '@/lib/clipboard'
import { brandText } from '@/lib/brand.generated'

const copyToClipboard = async (text: string) => {
  const result = await copyTextToClipboard(text)
  if (!result.ok) {
    console.error('Failed to copy to clipboard:', result.error)
  }
}

const reactNodeToText = (value: React.ReactNode): string => {
  if (value == null || typeof value === "boolean") {
    return ""
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(reactNodeToText).join(" ").trim()
  }
  if (isValidElement(value)) {
    const element = value as React.ReactElement<{ children?: React.ReactNode }>
    return reactNodeToText(element.props?.children)
  }
  return ""
}

const resolveToastDescription = (description: ExternalToast["description"]): React.ReactNode => {
  if (typeof description === "function") {
    return description()
  }
  return description
}

const isStringNode = (value: React.ReactNode): value is string =>
  Object.prototype.toString.call(value) === "[object String]"

const isDescriptionFactory = (
  value: ExternalToast["description"],
): value is () => React.ReactNode => value instanceof Function

const brandToastNode = (value: React.ReactNode): React.ReactNode =>
  isStringNode(value) ? brandText(value) : value

const brandToastData = (data?: ExternalToast): ExternalToast | undefined => {
  if (data?.description == null) {
    return data
  }
  const description = data.description
  return {
    ...data,
    description: isDescriptionFactory(description)
      ? () => brandToastNode(description())
      : brandToastNode(description),
  }
}

const getToastCopyText = (message: string | React.ReactNode, data?: ExternalToast): string => {
  const descriptionText = reactNodeToText(resolveToastDescription(data?.description))
  if (descriptionText.length > 0) {
    return descriptionText
  }
  return reactNodeToText(message)
}

// Wrapper to automatically add OK button to success and info toasts, Copy button to error and warning toasts
export const toast = {
  ...sonnerToast,
  success: (message: string | React.ReactNode, data?: ExternalToast) => {
    const brandedMessage = brandToastNode(message)
    const brandedData = brandToastData(data)
    return sonnerToast.success(brandedMessage, {
      ...brandedData,
      action: brandedData?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  info: (message: string | React.ReactNode, data?: ExternalToast) => {
    const brandedMessage = brandToastNode(message)
    const brandedData = brandToastData(data)
    return sonnerToast.info(brandedMessage, {
      ...brandedData,
      action: brandedData?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  error: (message: string | React.ReactNode, data?: ExternalToast) => {
    const brandedMessage = brandToastNode(message)
    const brandedData = brandToastData(data)
    return sonnerToast.error(brandedMessage, {
      ...brandedData,
      action: brandedData?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(brandedMessage, brandedData)),
      },
    })
  },
  warning: (message: string | React.ReactNode, data?: ExternalToast) => {
    const brandedMessage = brandToastNode(message)
    const brandedData = brandToastData(data)
    return sonnerToast.warning(brandedMessage, {
      ...brandedData,
      action: brandedData?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(brandedMessage, brandedData)),
      },
    })
  },
}
