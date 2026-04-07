export class LitterRobotException extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "LitterRobotException";
  }
}

export class LitterRobotLoginException extends LitterRobotException {
  constructor(message?: string) {
    super(message);
    this.name = "LitterRobotLoginException";
  }
}

export class InvalidCommandException extends LitterRobotException {
  constructor(message?: string) {
    super(message);
    this.name = "InvalidCommandException";
  }
}
