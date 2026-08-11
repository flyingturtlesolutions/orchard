# REFERENCE — Shopify admin: the FULL DraftOrderDetails_0 document (fallback for shopify_draft_order)

Captured verbatim from `admin.shopify.com.har` (2026-08-11, entry 92) — the admin UI reading ONE draft order.
Kept here because that HAR lives in a Downloads folder and will not survive; this file is the durable copy.

## When you need this

`shopify_draft_order` (Core/connectorRecipes.js, AU-6 §12.5) sends a FIVE-FIELD document of our own under this
same operation name. That is expected to work: `shopify_order`, `shopify_customer_by_email` and
`shopify_search_products` all send our own documents under Shopify operation names, and the first of those is
live-proven 40× — so the BFF routes on the NAME and executes whatever document it is handed.

If that assumption is wrong, the symptom is LOUD and specific:

    INVOKE ▸ admin.shopify.com POST [shopify_draft_order] → FAIL http-404 (or graphql-error)

and the fix is to replace `_GQL_DRAFT_ONE` with the document below, VERBATIM — whitespace included, in case the
BFF is matching on a hash. The three variables it takes are already what the leg sends plus two permission
booleans, so the leg's `body.variables` becomes:

    { id: '{draft_gid}', hasDiscountsPermission: false, hasVaultedPaymentPermissions: false }

Note what stays true either way: the fields the hand-off reads — `order { id name }`, `status`, `completedAt` —
are in BOTH documents. Swapping to this one changes only how much else comes back with them.

## The document

```graphql
query DraftOrderDetails_0($id: ID!, $hasDiscountsPermission: Boolean = true, $hasVaultedPaymentPermissions: Boolean = false) {
  draftOrder(id: $id) {
    id
    defaultCursor
    acceptAutomaticDiscounts
    allowDiscountCodesInCheckout
    allVariantPricesOverridden
    anyVariantPricesOverridden
    discountCodes
    taxesIncluded
    dutiesIncluded
    reserveInventoryUntil
    alerts {
      dismissibleHandle
      __typename
    }
    lockPricesForBuyer
    attributions {
      retail {
        locationId
        userId
        deviceId
        __typename
      }
      __typename
    }
    platformDiscounts {
      id
      title
      code
      summary
      automaticDiscount
      discountClasses
      discountReferenceHash
      totalAmountPriceSet {
        presentmentMoney {
          amount
          currencyCode
          __typename
        }
        __typename
      }
      presentationLevel
      discountDefinition @include(if: $hasDiscountsPermission) {
        id
        __typename
        discount {
          __typename
        }
      }
      allocations {
        id
        reductionAmount {
          amount
          currencyCode
          __typename
        }
        target {
          __typename
        }
        __typename
      }
      __typename
    }
    appliedDiscount {
      amountSet {
        presentmentMoney {
          amount
          currencyCode
          __typename
        }
        shopMoney {
          amount
          currencyCode
          __typename
        }
        __typename
      }
      amountWithCurrency {
        amount
        currencyCode
        __typename
      }
      value
      valueType
      description
      __typename
    }
    totalDiscountsSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    billingAddress {
      id
      id
      name
      latitude
      longitude
      formatted(withName: true, withCompany: true)
      phone
      company
      firstName
      lastName
      address1
      address2
      city
      provinceCode
      zip
      countryCodeV2
      isShopifyOffice
      verified
      __typename
      __typename
    }
    billingAddressMatchesShippingAddress
    currencyCode
    customAttributes {
      key
      value
      __typename
    }
    completedAt
    createdAt
    deposit {
      ... on DepositPercentage {
        percentage
        __typename
      }
      __typename
    }
    amountDueNowSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    amountDueLaterSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    email
    phone
    name
    note2
    requiresShipping
    status
    tags
    updatedAt
    order {
      id
      __typename
    }
    lastUser {
      id
      name
      __typename
    }
    lastModifiedByApp
    paymentTerms {
      id
      hasDueTodayPaymentSchedule
      overdue
      paymentTermsName
      translatedName
      paymentTermsType
      paymentTermsTemplateId
      paymentSchedules(first: 1) {
        edges {
          node {
            id
            dueAt
            completedAt
            issuedAt
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    shippingAddress {
      id
      id
      name
      latitude
      longitude
      formatted(withName: true, withCompany: true)
      phone
      company
      firstName
      lastName
      address1
      address2
      city
      provinceCode
      zip
      countryCodeV2
      isShopifyOffice
      verified
      __typename
      __typename
    }
    shippingLine {
      id
      custom
      shippingRateHandle
      title
      deliveryCategory
      code
      source
      customShippingInputPrice {
        amount
        currencyCode
        __typename
      }
      discountedPriceSet {
        presentmentMoney {
          amount
          currencyCode
          __typename
        }
        shopMoney {
          amount
          currencyCode
          __typename
        }
        __typename
      }
      originalPriceSet {
        presentmentMoney {
          amount
          currencyCode
          __typename
        }
        shopMoney {
          amount
          currencyCode
          __typename
        }
        __typename
      }
      __typename
    }
    taxExempt
    totalPriceSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    lineItemsSubtotalPrice {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    totalTaxSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      shopMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    totalDutiesSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    incotermInformation {
      incoterm
      reason
      adaptivePricing
      __typename
    }
    totalAdditionalFeesSet {
      presentmentMoney {
        amount
        currencyCode
        __typename
      }
      __typename
    }
    invoiceEmailTemplateSubject
    invoiceSentAt
    invoiceUrl
    presentmentCurrencyCode
    marketName
    marketRegionCountryCode
    merchantBusinessEntity {
      id
      __typename
    }
    warnings {
      message
      errorCode
      field
      ... on DraftOrderDiscountNotAppliedWarning {
        discountCode
        discountTitle
        errorCode
        field
        message
        __typename
      }
      __typename
    }
    vaultedPaymentMethods @include(if: $hasVaultedPaymentPermissions) {
      id
      paymentInstrument {
        ... on BankAccount {
          __typename
          lastDigits
          bankName
          accountType
          accountHolderType
        }
        ... on VaultCreditCard {
          brand
          lastDigits
          expiryMonth
          expiryYear
          expired
          name
          __typename
        }
        __typename
      }
      scope
      __typename
      __typename
    }
    poNumber
    currentMarketManager
    cardsinkCallerIdentificationToken
    sessionToken
    transformerFingerprint
    totalQuantityOfLineItems
    bypassCartValidations
    marketManagerOverride
    __typename
    ready
    __typename
  }
}
```

## The variables the admin sent

```json
{
  "hasDiscountsPermission": false,
  "hasVaultedPaymentPermissions": false,
  "id": "gid://shopify/DraftOrder/<id>"
}
```
