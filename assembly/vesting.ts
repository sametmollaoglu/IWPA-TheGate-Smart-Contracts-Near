import {
  logging,
  PersistentMap,
  Context,
  u128,
  storage,
  ContractPromise,
} from "near-sdk-as";

export const TGAS: u64 = 1000000000000;
export const XCC_SUCCESS = 1;
export const NO_DEPOSIT: u128 = u128.Zero;
export const DAY: u64 = 24 * 60 * 60;

export const icoStates = new PersistentMap<u32, u32>("icoStates"); //ico type(eg.; 0:public, 1:seed, 2:family) => state (0:active, 1:nonactive, 2:done)

export const vestingSchedules = new PersistentMap<string, VestingSchedule>(
  "vestingSchedule"
); //address+icotype -> vestingschedule

@nearBindgen
export class VestingSchedule {
  beneficiaryAddress: string;
  icoStartDate: u64; //give date as second
  numberOfCliff: u32;
  numberOfVesting: u32;
  unlockRate: u32;
  isRevocable: boolean;
  revoked: boolean;
  cliffAndVestingAllocation: u32; // Total amount of tokens to be released at the end of the vesting cliff + vesting
  vestingAllocation: u32; // Total amount of tokens to be released at the end of the vesting only vesting
  tgeVested: boolean;
  releasedPeriod: u32;
  icoType: u32;
  investedUSDT: u32;
  isClaimed: boolean;
  tokenAbsoluteUsdtPrice: u32;

  constructor() {
    this.revoked = false;
    this.tgeVested = false;
    this.releasedPeriod = 0;
    this.isClaimed = false;
  }
}

export function setCrowdsaleAddress(_address: string): void {
  _onlyOwner("setCrowdsaleAddress");
  storage.set("crowdsale-address", _address);
}

export function claimAsToken(_icoType: u32): void {
  const beneficiary = Context.sender;
  var vestingKeyString = beneficiary.concat(_icoType.toString());

  assert(
    icoStates.contains(_icoType),
    "ERROR at claimAsToken: There is no sale round with this type."
  );

  assert(
    vestingSchedules.contains(vestingKeyString),
    "ERROR at claimAsToken: You are not the member of this sale."
  );

  var vesting = vestingSchedules.getSome(vestingKeyString);

  assert(
    !vesting.revoked,
    "ERROR at claimAsToken: Vesting Schedule is revoked."
  );

  var state = icoStates.getSome(_icoType);

  assert(state != 1, "ERROR at claimAsToken: Sale round is currently stopped.");

  var releasableAmount = u32(_getReleasableAmount(beneficiary, _icoType));
  assert(
    releasableAmount > 0,
    "ERROR at claimAsToken: Releasable amount is 0."
  );

  _processPurchaseToken(beneficiary, _icoType, releasableAmount);
  increaseICOtokenSoldCall(releasableAmount, _icoType);
}

/**
 * @CALLED_FUNCS
 */
//////////////////////////////////////////////////////////////////////////////////////////
export function createVestingSchedule(
  _beneficiaryAddress: string,
  _icoType: u32,
  _allocation: u32,
  _numberOfCliffMonths: u32,
  _numberOfVestingMonths: u32,
  _unlockRate: u32,
  _isRevocable: boolean,
  _investedUsdt: u32,
  _icoStartDate: u64,
  _tokenAbsoluteUsdtPrice: u32
): void {
  _onlyCrowdsaleContract("createVestingSchedule");

  var vestingKeyString = _beneficiaryAddress.concat(_icoType.toString());

  var newVestingSchedule = new VestingSchedule();

  var vestingAllocation = _allocation - (_unlockRate * _allocation) / 100;

  newVestingSchedule.beneficiaryAddress = _beneficiaryAddress;
  newVestingSchedule.icoType = _icoType;
  newVestingSchedule.icoStartDate = _icoStartDate;
  newVestingSchedule.numberOfCliff = _numberOfCliffMonths;
  newVestingSchedule.numberOfVesting = _numberOfVestingMonths;
  newVestingSchedule.unlockRate = _unlockRate;
  newVestingSchedule.cliffAndVestingAllocation = _allocation;
  newVestingSchedule.vestingAllocation = vestingAllocation;
  newVestingSchedule.tokenAbsoluteUsdtPrice = _tokenAbsoluteUsdtPrice;
  newVestingSchedule.isRevocable = _isRevocable;
  newVestingSchedule.investedUSDT = _investedUsdt;

  vestingSchedules.set(vestingKeyString, newVestingSchedule);
}

export function updateVestingSchedule(
  _vestingKeyString: string,
  _tokenAmount: u32,
  _totalVestingAllocation: u32,
  _usdtAmount: u32
): void {
  _onlyCrowdsaleContract("updateVestingSchedule");

  logging.log("updatevestingcontract");
  logging.log(_vestingKeyString);

  assert(
    vestingSchedules.contains(_vestingKeyString),
    "ERROR at updateVestingSchedule: You are not the member of this sale."
  );

  var vesting = vestingSchedules.getSome(_vestingKeyString);

  logging.log("varmis");
  vesting.cliffAndVestingAllocation += _tokenAmount; //cliffAndVestingAllocation
  vesting.vestingAllocation += _totalVestingAllocation; //vestingAllocation
  vesting.investedUSDT += _usdtAmount; //investedUSDT
  logging.log("varmis2");
  vestingSchedules.set(_vestingKeyString, vesting);
}

export function changeICOstate(_icoType: u32, _icoState: u32): void {
  _onlyCrowdsaleContract("changeICOstate");

  icoStates.set(_icoType, _icoState);
}

/**
 * @UTILS
 */
//////////////////////////////////////////////////////////////////////////////////////////
function _getReleasableAmount(_beneficiary: string, _icoType: u32): f64 {
  var vestingKeyString = _beneficiary.concat(_icoType.toString());
  var vesting = vestingSchedules.getSome(vestingKeyString);

  assert(
    vesting.icoStartDate != 0,
    "ERROR at getReleasableAmount: Vesting does not exist."
  );
  assert(
    vesting.releasedPeriod < vesting.numberOfVesting,
    "ERROR at getReleasableAmount: You claimed all of your vesting."
  );

  var currentTime = _getTimeAsSeconds();
  logging.log(currentTime);

  assert(
    currentTime > vesting.icoStartDate,
    "ERROR at getReleasableAmount: ICO is not started yet"
  );

  var releasableAmount: f64 = 0;

  var elapsedMonthNumber = _getElapsedMonth(vesting.icoStartDate, currentTime);

  if (elapsedMonthNumber > vesting.numberOfVesting + vesting.numberOfCliff) {
    elapsedMonthNumber = vesting.numberOfVesting + vesting.numberOfCliff;

    //bu değerin true olması için token dağıtımından emin olunmalı
    vesting.isClaimed = true;
  } else if (elapsedMonthNumber < vesting.numberOfCliff) {
    return 0;
  }

  var vestedMonthNumber =
    elapsedMonthNumber - vesting.numberOfCliff - vesting.releasedPeriod;

  if (!vesting.tgeVested) {
    var unlockAmount = f64.div(
      vesting.cliffAndVestingAllocation * vesting.unlockRate,
      100
    );

    releasableAmount += unlockAmount;
    vesting.tgeVested = true;
  }

  if (vestedMonthNumber > 0) {
    var vestedAmount =
      f64.div(vesting.vestingAllocation, vesting.numberOfVesting) *
      vestedMonthNumber;

    releasableAmount += vestedAmount;
    vesting.releasedPeriod += vestedMonthNumber;
  }
  vestingSchedules.set(vestingKeyString, vesting);
  return releasableAmount;
}

function _getElapsedMonth(_icoStartDate: u64, _currentTime: u64): u32 {
  return u32((_currentTime - _icoStartDate) / 300); //5dk
}

function _getTimeAsSeconds(): u64 {
  return Context.blockTimestamp / 10 ** 9;
}

function _processPurchaseToken(
  _beneficiary: string,
  _icoType: u32,
  _releasableAmount: u32
): void {
  //token.transferFrom(owner(), _beneficiary, _releasableAmount);
  //emit tokenClaimed(_beneficiary, _icoType, _releasableAmount);
}

function _onlyOwner(funcName: string): void {
  assert(
    Context.predecessor == Context.contractName,
    funcName + "method is private. Only owner call this function."
  );
}

function _onlyCrowdsaleContract(funcName: string): void {
  const crowdsaleContractAddress: string = storage.getPrimitive<string>(
    "crowdsale-address",
    ""
  );
  assert(
    Context.predecessor == crowdsaleContractAddress,
    funcName + "method is private. Only crowdsale contract call this function."
  );
}
//////////////////////////////////////////////////////////////////////////////////////////

/**
 * @VIEW
 */
//////////////////////////////////////////////////////////////////////////////////////////

export function getVestingScheduleStagesUI(
  _beneficiaryAddress: string,
  _icoType: u32
): Array<Array<f64>> {
  var vestingKeyString = _beneficiaryAddress.concat(_icoType.toString());

  assert(
    vestingSchedules.contains(vestingKeyString),
    "ERROR at getVestingScheduleStagesUI: You are not the member of this sale."
  );
  var vesting = vestingSchedules.getSome(vestingKeyString);

  var dateTimestamp = f64(vesting.icoStartDate);

  var cliffTokenAllocation = f64.div(
    vesting.cliffAndVestingAllocation * vesting.unlockRate,
    100
  );

  var cliffUsdtAllocation = f64.div(
    cliffTokenAllocation * vesting.tokenAbsoluteUsdtPrice,
    10 ** 6
  );

  var stage0 = new Array<f64>();
  stage0.push(dateTimestamp);
  stage0.push(cliffTokenAllocation);
  stage0.push(cliffUsdtAllocation);
  stage0.push(vesting.unlockRate);
  var stageArray = new Array<Array<f64>>();

  stageArray.push(stage0);

  dateTimestamp += 30 * f64(DAY) * vesting.numberOfCliff;

  var tokenAmountAfterCliff = f64.div(
    vesting.vestingAllocation,
    vesting.numberOfVesting
  );

  var usdtAmountAfterCliff = f64.div(
    vesting.investedUSDT - cliffUsdtAllocation,
    vesting.numberOfVesting
  );

  var vestingRatesAfterCliff = f64.div(
    100 - vesting.unlockRate,
    vesting.numberOfVesting
  );

  for (var i: u32 = 0; i < vesting.numberOfVesting; i++) {
    var tempStage = new Array<f64>();
    tempStage.push(dateTimestamp);
    tempStage.push(tokenAmountAfterCliff);
    tempStage.push(usdtAmountAfterCliff);
    tempStage.push(vestingRatesAfterCliff);
    stageArray.push(tempStage);
    dateTimestamp += 30 * f64(DAY);
  }
  return stageArray;
}

export function getVestingSchedule(
  _beneficiaryAddress: string,
  _icoType: u32
): void {
  var vestingKeyString = _beneficiaryAddress.concat(_icoType.toString());

  assert(
    vestingSchedules.contains(vestingKeyString),
    "ERROR at getVestingSchedule: You are not the member of this sale."
  );

  var vesting = vestingSchedules.getSome(vestingKeyString);

  logging.log(vesting.icoStartDate);
  logging.log(vesting.numberOfCliff);
  logging.log(vesting.numberOfVesting);
  logging.log(vesting.unlockRate);
  logging.log(vesting.isRevocable ? 1 : 0);
  logging.log(vesting.revoked ? 1 : 0);
  logging.log(vesting.cliffAndVestingAllocation);
  logging.log(vesting.vestingAllocation);
  logging.log(vesting.tgeVested ? 1 : 0);
  logging.log(vesting.releasedPeriod);
  logging.log(vesting.icoType);
  logging.log(vesting.investedUSDT);
  logging.log(vesting.isClaimed ? 1 : 0);
  logging.log(vesting.tokenAbsoluteUsdtPrice);
}
export function viewReleasableAmount(_beneficiary: string, _icoType: u32): f64 {
  var vestingKeyString = _beneficiary.concat(_icoType.toString());

  assert(
    vestingSchedules.contains(vestingKeyString),
    "ERROR at viewReleasableAmount: You are not the member of this sale."
  );

  var vesting = vestingSchedules.getSome(vestingKeyString);

  assert(
    vesting.releasedPeriod < vesting.numberOfVesting,
    "ERROR at viewReleasableAmount: You claimed all of your vesting."
  );

  var currentTime = _getTimeAsSeconds();

  assert(
    currentTime > vesting.icoStartDate,
    "ERROR at viewReleasableAmount: ICO is not started yet"
  );

  var elapsedMonthNumber = _getElapsedMonth(vesting.icoStartDate, currentTime);

  if (elapsedMonthNumber > vesting.numberOfVesting + vesting.numberOfCliff) {
    elapsedMonthNumber = vesting.numberOfVesting + vesting.numberOfCliff;
  } else if (elapsedMonthNumber < vesting.numberOfCliff) {
    return 0;
  }

  var vestedMonthNumber =
    elapsedMonthNumber - vesting.numberOfCliff - vesting.releasedPeriod;

  var releasableAmount: f64 = 0;

  if (!vesting.tgeVested) {
    var unlockAmount = f64.div(
      vesting.cliffAndVestingAllocation * vesting.unlockRate,
      100
    );

    releasableAmount += unlockAmount;
  }
  if (vestedMonthNumber > 0) {
    var vestedAmount =
      f64.div(vesting.vestingAllocation, vesting.numberOfVesting) *
      vestedMonthNumber;

    releasableAmount += vestedAmount;
  }
  return releasableAmount;
}
//////////////////////////////////////////////////////////////////////////////////////////

//increaseICOtokenSoldCall claim ardından ico contractındaki _icotype icosunun sold değerini amount kadar artırır
////////////////////////////////////////////////////////////////////////////////////
@nearBindgen
class increaseICOtokenSoldCallArgs {
  constructor(public _amount: u32, public _icoType: u32) {}
}

function increaseICOtokenSoldCall(_amount: u32, _icoType: u32): void {
  assert(Context.prepaidGas >= 20 * TGAS, "Please attach at least 20 Tgas");
  const crowdsaleContractAddress: string = storage.getPrimitive<string>(
    "crowdsale-address",
    ""
  );
  const args: increaseICOtokenSoldCallArgs = new increaseICOtokenSoldCallArgs(
    _amount,
    _icoType
  );
  const promise: ContractPromise = ContractPromise.create(
    crowdsaleContractAddress,
    "increaseICOtokenSold",
    args,
    5 * TGAS,
    NO_DEPOSIT
  );
  // Create a promise to callback, needs 5 Tgas
  const callbackPromise = promise.then(
    Context.contractName,
    "increaseICOtokenSoldCallCallback",
    "{}",
    5 * TGAS,
    NO_DEPOSIT
  );

  callbackPromise.returnAsResult();
}
// Public callback
export function increaseICOtokenSoldCallCallback(): bool {
  _onlyOwner("increaseICOtokenSoldCallCallback");

  const results = ContractPromise.getResults();
  assert(results.length == 1, "This is a callback method");

  const response = results[0];

  if (response.status == XCC_SUCCESS) {
    // `set_greeting` succeeded
    return true;
  } else {
    // it failed
    return false;
  }
}
////////////////////////////////////////////////////////////////////////////////////
