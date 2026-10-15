const ADMIN_API = ['127.0.0.1', 'localhost'].includes(location.hostname) ? 'http://127.0.0.1:5001/api' : 'https://iploan-api.mustree.kr/api';
const MVP_BANK_ADMIN = '0xB3Ec5f2bbB80e90ec457165d13EF469893a54951';
let deploying = false, deployedAddress = null;
const result = document.getElementById('adminResult');
IPLoanChain.init(ADMIN_API);
document.getElementById('deployManager').onclick = async () => {
  if (deploying) return;
  deploying = true;
  try {
    const ctx = await IPLoanChain.connect(null, MVP_BANK_ADMIN);
    if (IPLoanChain.config()?.enabled) throw new Error('서버에 계약이 이미 연결되어 있습니다. 재배포하지 말고 신청 화면을 사용하세요.');
    const evaluator = ethers.getAddress(document.getElementById('adminEvaluator').value.trim());
    const bank = ethers.getAddress(document.getElementById('adminBank').value.trim());
    if (bank !== MVP_BANK_ADMIN) throw new Error('은행 수령 주소와 관리자 주소는 확정된 은행 지갑이어야 합니다.');
    const network = await ctx.provider.getNetwork();
    const overrides = IPLoanChain.transactionOverrides();
    const feeNotice = overrides.gasPrice === 0n ? 'Mustsem gasPrice=0 요청입니다. 노드가 거부하면 유료 가격으로 재시도하지 않습니다.' : '네트워크 가스 요금이 소모됩니다.';
    const response = await fetch('blockchain/artifacts/IPLoanManager.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('먼저 blockchain에서 npm run compile을 실행하세요.');
    const artifact = await response.json();
    if (!artifact.compiler?.version?.startsWith('0.8.24+')) throw new Error('Solidity 0.8.24 산출물로 다시 컴파일하세요.');
    if (artifact.compiler.evmVersion !== 'paris') throw new Error('EVM Paris 산출물이 아닙니다. 다시 컴파일하세요.');
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, ctx.signer);
    const request = await factory.getDeployTransaction(ctx.address, evaluator, bank);
    let previous;
    try { previous = JSON.parse(localStorage.getItem(`iploan-deployment:${network.chainId}`) || 'null'); } catch { /* Server fallback below. */ }
    const previousHash = previous?.txHash || IPLoanChain.config().pendingDeploymentTxHash;
    let retryNotice = '';
    if (previousHash) {
      const oldTx = await ctx.provider.getTransaction(previousHash);
      if (!oldTx) throw new Error('이전 배포 거래를 노드에서 찾지 못했습니다. 중복 배포하지 말고 거래 상태를 먼저 확인하세요.');
      if (oldTx.from.toLowerCase() !== ctx.address.toLowerCase() || oldTx.to !== null ||
          oldTx.data.toLowerCase() !== request.data.toLowerCase() || oldTx.chainId !== network.chainId || oldTx.value !== 0n) {
        throw new Error('이전 배포가 현재 지갑·계약·네트워크 설정과 다릅니다. 자동 교체하지 않습니다.');
      }
      const receipt = await ctx.provider.getTransactionReceipt(previousHash);
      if (receipt) {
        if (receipt.status !== 1) throw new Error('이전 배포는 실패한 영수증으로 확정됐습니다. 먼저 원인을 확인하세요.');
        deployedAddress = receipt.contractAddress;
        result.textContent = `기존 배포 완료 확인\n배포 tx: ${previousHash}\nManager: ${deployedAddress}\n다음: 차주 역할 부여를 진행하세요. 재배포하지 않습니다.`;
        return;
      }
      if (await ctx.provider.getTransactionCount(ctx.address, 'latest') !== oldTx.nonce) {
        throw new Error('이전 nonce가 다른 거래로 처리되었습니다. 새 거래 hash를 확인하세요.');
      }
      if (network.chainId !== 7601n || IPLoanChain.config().zeroGasPrice) {
        throw new Error('이전 배포가 대기 중입니다. 중복 배포하지 말고 확정 여부를 확인하세요.');
      }
      const fees = await ctx.provider.getFeeData();
      if (fees.gasPrice == null || fees.gasPrice <= 0n) throw new Error('정상 수수료를 조회하지 못했습니다.');
      const minimum = (oldTx.gasPrice || 0n) * 125n / 100n + 1n;
      overrides.type = 0;
      overrides.gasPrice = fees.gasPrice > minimum ? fees.gasPrice : minimum;
      overrides.nonce = oldTx.nonce;
      retryNotice = `기존 배포 ${previousHash}를 같은 nonce ${oldTx.nonce}, gasPrice ${overrides.gasPrice} wei로 교체합니다. 새 nonce 배포가 아닙니다.`;
    }
    if (!confirm(`체인 ${network.chainId}, 관리자 ${ctx.address}, 평가사 ${evaluator}, 은행 ${bank}. ${retryNotice || feeNotice} MetaMask의 최종 수수료를 확인하고 진행할까요?`)) return;
    const contract = await factory.deploy(ctx.address, evaluator, bank, overrides);
    const tx = contract.deploymentTransaction();
    deployedAddress = await contract.getAddress();
    const explorer = network.chainId === 11155111n ? `\nhttps://sepolia.etherscan.io/tx/${tx.hash}` : '';
    result.textContent = `배포 전송: ${tx.hash}${explorer}\n예상 계약 주소: ${deployedAddress}\n영수증 대기 중…`;
    localStorage.setItem(`iploan-deployment:${network.chainId}`, JSON.stringify({ address: deployedAddress, txHash: tx.hash }));
    await tx.wait(1, 120000);
    result.textContent = `배포 완료\n배포 tx: ${tx.hash}${explorer}\nSolidity: ${artifact.compiler.version}\nManager: ${deployedAddress}\nSBT: ${await contract.accessSBT()}\n채권 NFT: ${await contract.debtNFT()}\n\n다음: 같은 은행 관리자 지갑에서 차주 역할 부여 버튼을 누르세요.\n두 거래 완료 후 관리자가 Manager 주소를 IPLOAN_MANAGER_ADDRESS에 설정하고 서버를 재시작하세요. 배포 tx와 차주 역할 tx는 검증 기록으로 보관하세요.`;
  } catch (error) { result.textContent += '\n' + (error.shortMessage || error.message); }
  finally { deploying = false; }
};
document.getElementById('grantBorrower').onclick = async () => {
  if (deploying) return;
  deploying = true;
  try {
    const ctx = await IPLoanChain.connect(null, MVP_BANK_ADMIN);
    const borrower = ethers.getAddress(document.getElementById('adminBorrower').value.trim());
    const target = deployedAddress || IPLoanChain.config()?.managerAddress;
    if (!target) throw new Error('계약을 배포하고 서버에 주소를 설정하세요.');
    const artifact = await (await fetch('blockchain/artifacts/IPLoanManager.json')).json();
    const manager = new ethers.Contract(target, artifact.abi, ctx.signer);
    if (await manager.hasRole(await manager.BORROWER_ROLE(), borrower)) { result.textContent += '\n차주 권한이 이미 등록되어 있습니다. 추가 거래가 필요 없습니다.'; return; }
    const overrides = IPLoanChain.transactionOverrides();
    if (!confirm(`차주 ${borrower}에 신청 권한을 부여할까요? ${overrides.gasPrice === 0n ? 'Mustsem gasPrice=0 요청입니다.' : 'MetaMask에서 가스 요금을 확인하세요.'}`)) return;
    const tx = await manager.grantRole(await manager.BORROWER_ROLE(), borrower, overrides);
    result.textContent += '\n권한 등록 전송: ' + tx.hash;
    await tx.wait(1, 120000);
    result.textContent += '\n차주 역할 등록 완료\n차주 역할 tx: ' + tx.hash + (IPLoanChain.config().chainId === 11155111 ? '\nhttps://sepolia.etherscan.io/tx/' + tx.hash : '') + '\n배포 tx와 차주 역할 tx를 보관하고 API의 계약 주소·네트워크 설정을 확인하세요.';
  } catch (error) { result.textContent += '\n' + (error.shortMessage || error.message); }
  finally { deploying = false; }
};
