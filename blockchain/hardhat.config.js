export default {
  solidity: "0.8.24",
  networks: { localTest: { type: "edr-simulated", chainType: "l1", chainId: Number(process.env.IPLOAN_LOCAL_CHAIN_ID || 31337) } }
};
