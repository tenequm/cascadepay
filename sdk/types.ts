/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/cascadepay.json`.
 */
export type Cascadepay = {
  address: "Bi1y2G3hteJwbeQk7QAW9Uk7Qq2h9bPbDYhPCKSuE2W2";
  metadata: {
    name: "cascadepay";
    version: "0.1.0";
    spec: "0.1.0";
    description: "Non-custodial payment splitter for Solana - distribute incoming payments to multiple recipients automatically";
    repository: "https://github.com/tenequm/cascadepay";
  };
  instructions: [
    {
      name: "claimUnclaimed";
      docs: ["Recipients claim their unclaimed funds"];
      discriminator: [83, 180, 69, 217, 176, 246, 35, 175];
      accounts: [
        {
          name: "recipient";
          signer: true;
        },
        {
          name: "splitConfig";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  115,
                  112,
                  108,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ];
              },
              {
                kind: "account";
                path: "split_config.authority";
                account: "splitConfig";
              },
              {
                kind: "account";
                path: "split_config.mint";
                account: "splitConfig";
              }
            ];
          };
        },
        {
          name: "vault";
          writable: true;
        },
        {
          name: "mint";
        },
        {
          name: "recipientAta";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "recipient";
              },
              {
                kind: "account";
                path: "tokenProgram";
              },
              {
                kind: "account";
                path: "split_config.mint";
                account: "splitConfig";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "tokenProgram";
        }
      ];
      args: [];
    },
    {
      name: "createSplitConfig";
      docs: [
        "Creates a new split configuration with vault",
        "Validates recipient ATAs on-chain (defense in depth)"
      ];
      discriminator: [128, 42, 60, 106, 4, 233, 18, 190];
      accounts: [
        {
          name: "splitConfig";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  115,
                  112,
                  108,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ];
              },
              {
                kind: "account";
                path: "authority";
              },
              {
                kind: "arg";
                path: "mint";
              }
            ];
          };
        },
        {
          name: "vault";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "account";
                path: "splitConfig";
              },
              {
                kind: "account";
                path: "tokenProgram";
              },
              {
                kind: "arg";
                path: "mint";
              }
            ];
            program: {
              kind: "const";
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ];
            };
          };
        },
        {
          name: "mint";
        },
        {
          name: "authority";
          writable: true;
          signer: true;
        },
        {
          name: "tokenProgram";
        },
        {
          name: "associatedTokenProgram";
          address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        },
        {
          name: "systemProgram";
          address: "11111111111111111111111111111111";
        }
      ];
      args: [
        {
          name: "mint";
          type: "pubkey";
        },
        {
          name: "recipients";
          type: {
            vec: {
              defined: {
                name: "recipient";
              };
            };
          };
        }
      ];
    },
    {
      name: "executeSplit";
      docs: [
        "Executes a payment split by draining vault",
        "Permissionless - anyone can call",
        "Gracefully handles missing recipient ATAs (holds as unclaimed)"
      ];
      discriminator: [6, 45, 171, 40, 49, 129, 23, 89];
      accounts: [
        {
          name: "splitConfig";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  115,
                  112,
                  108,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ];
              },
              {
                kind: "account";
                path: "split_config.authority";
                account: "splitConfig";
              },
              {
                kind: "account";
                path: "split_config.mint";
                account: "splitConfig";
              }
            ];
          };
        },
        {
          name: "vault";
          writable: true;
        },
        {
          name: "mint";
        },
        {
          name: "protocolFeeRecipient";
          writable: true;
        },
        {
          name: "executor";
        },
        {
          name: "tokenProgram";
        }
      ];
      args: [];
    },
    {
      name: "updateSplitConfig";
      docs: [
        "Updates split configuration",
        "Only callable by authority, requires vault empty"
      ];
      discriminator: [47, 103, 74, 170, 55, 251, 130, 146];
      accounts: [
        {
          name: "authority";
          writable: true;
          signer: true;
          relations: ["splitConfig"];
        },
        {
          name: "splitConfig";
          writable: true;
          pda: {
            seeds: [
              {
                kind: "const";
                value: [
                  115,
                  112,
                  108,
                  105,
                  116,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ];
              },
              {
                kind: "account";
                path: "authority";
              },
              {
                kind: "account";
                path: "split_config.mint";
                account: "splitConfig";
              }
            ];
          };
        },
        {
          name: "vault";
          writable: true;
        }
      ];
      args: [
        {
          name: "newRecipients";
          type: {
            vec: {
              defined: {
                name: "recipient";
              };
            };
          };
        }
      ];
    }
  ];
  accounts: [
    {
      name: "splitConfig";
      discriminator: [49, 201, 50, 228, 22, 142, 12, 222];
    }
  ];
  events: [
    {
      name: "recipientPaymentHeld";
      discriminator: [120, 223, 189, 236, 111, 137, 55, 6];
    },
    {
      name: "splitConfigCreated";
      discriminator: [48, 207, 235, 42, 217, 76, 100, 46];
    },
    {
      name: "splitConfigUpdated";
      discriminator: [46, 59, 153, 50, 174, 164, 44, 202];
    },
    {
      name: "splitExecuted";
      discriminator: [147, 176, 193, 145, 52, 30, 166, 53];
    },
    {
      name: "unclaimedFundsClaimed";
      discriminator: [216, 251, 141, 75, 141, 244, 19, 162];
    }
  ];
  errors: [
    {
      code: 6000;
      name: "invalidSplitTotal";
      msg: "Recipients must total exactly 9900 basis points (99%)";
    },
    {
      code: 6001;
      name: "invalidRecipientCount";
      msg: "Must have between 2 and 20 recipients";
    },
    {
      code: 6002;
      name: "duplicateRecipient";
      msg: "Duplicate recipient address detected";
    },
    {
      code: 6003;
      name: "zeroAddress";
      msg: "Recipient address cannot be zero";
    },
    {
      code: 6004;
      name: "zeroPercentage";
      msg: "Recipient percentage cannot be zero";
    },
    {
      code: 6005;
      name: "vaultNotEmpty";
      msg: "Vault balance must be 0 to update or close config";
    },
    {
      code: 6006;
      name: "invalidVault";
      msg: "Provided vault account does not match config vault";
    },
    {
      code: 6007;
      name: "mathOverflow";
      msg: "Math overflow occurred";
    },
    {
      code: 6008;
      name: "mathUnderflow";
      msg: "Math underflow occurred";
    },
    {
      code: 6009;
      name: "recipientAtaCountMismatch";
      msg: "Number of recipient ATAs passed doesn't match recipients length";
    },
    {
      code: 6010;
      name: "recipientAtaDoesNotExist";
      msg: "Recipient ATA does not exist. Create it first.";
    },
    {
      code: 6011;
      name: "recipientAtaInvalid";
      msg: "Recipient account is not a valid token account";
    },
    {
      code: 6012;
      name: "recipientAtaWrongOwner";
      msg: "Recipient ATA has wrong owner (doesn't belong to recipient)";
    },
    {
      code: 6013;
      name: "recipientAtaWrongMint";
      msg: "Recipient ATA has wrong mint (not for this token)";
    },
    {
      code: 6014;
      name: "recipientAtaInvalidOwner";
      msg: "Recipient ATA is owned by wrong program (not Token or Token-2022)";
    },
    {
      code: 6015;
      name: "recipientAtaShouldBeReadOnly";
      msg: "Recipient ATA should be read-only during config creation";
    },
    {
      code: 6016;
      name: "tooManyUnclaimedEntries";
      msg: "Too many unclaimed entries (max 20)";
    },
    {
      code: 6017;
      name: "invalidProtocolFeeAccount";
      msg: "Protocol fee recipient has wrong mint";
    },
    {
      code: 6018;
      name: "nothingToClaim";
      msg: "Recipient has no unclaimed funds to claim";
    },
    {
      code: 6019;
      name: "unclaimedFundsExist";
      msg: "Config still has unclaimed funds - cannot close";
    }
  ];
  types: [
    {
      name: "recipient";
      type: {
        kind: "struct";
        fields: [
          {
            name: "address";
            type: "pubkey";
          },
          {
            name: "percentageBps";
            type: "u16";
          }
        ];
      };
    },
    {
      name: "recipientPaymentHeld";
      type: {
        kind: "struct";
        fields: [
          {
            name: "config";
            type: "pubkey";
          },
          {
            name: "recipient";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "reason";
            type: "string";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    },
    {
      name: "splitConfig";
      type: {
        kind: "struct";
        fields: [
          {
            name: "version";
            type: "u8";
          },
          {
            name: "authority";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "recipients";
            type: {
              vec: {
                defined: {
                  name: "recipient";
                };
              };
            };
          },
          {
            name: "unclaimedAmounts";
            type: {
              vec: {
                defined: {
                  name: "unclaimedAmount";
                };
              };
            };
          },
          {
            name: "bump";
            type: "u8";
          }
        ];
      };
    },
    {
      name: "splitConfigCreated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "config";
            type: "pubkey";
          },
          {
            name: "authority";
            type: "pubkey";
          },
          {
            name: "mint";
            type: "pubkey";
          },
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "recipientsCount";
            type: "u8";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    },
    {
      name: "splitConfigUpdated";
      type: {
        kind: "struct";
        fields: [
          {
            name: "config";
            type: "pubkey";
          },
          {
            name: "authority";
            type: "pubkey";
          },
          {
            name: "oldRecipientsCount";
            type: "u8";
          },
          {
            name: "newRecipientsCount";
            type: "u8";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    },
    {
      name: "splitExecuted";
      type: {
        kind: "struct";
        fields: [
          {
            name: "config";
            type: "pubkey";
          },
          {
            name: "vault";
            type: "pubkey";
          },
          {
            name: "totalAmount";
            type: "u64";
          },
          {
            name: "recipientsDistributed";
            type: "u64";
          },
          {
            name: "protocolFee";
            type: "u64";
          },
          {
            name: "heldCount";
            type: "u64";
          },
          {
            name: "executor";
            type: "pubkey";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    },
    {
      name: "unclaimedAmount";
      type: {
        kind: "struct";
        fields: [
          {
            name: "recipient";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    },
    {
      name: "unclaimedFundsClaimed";
      type: {
        kind: "struct";
        fields: [
          {
            name: "config";
            type: "pubkey";
          },
          {
            name: "recipient";
            type: "pubkey";
          },
          {
            name: "amount";
            type: "u64";
          },
          {
            name: "timestamp";
            type: "i64";
          }
        ];
      };
    }
  ];
};
