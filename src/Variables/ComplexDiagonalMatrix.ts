import { Matrix } from './Matrix';

/*
 * Class that adds support for complex diagonal matrices.
 * These need special treatment because they are considered Diagonal Matrices.
 */
export class ComplexDiagonalMatrix extends Matrix {
	private static TYPENAME: string = 'diagonal matrix';
	/***************************************************************************
	 * @param name the variable name without indices.
	 * @param value the contents of the variable.
	 * @param freeIndices the number of elements in each dimension.
	 * @param fixedIndices if this is a part of a larger matrix, the right-most
	 * indices that are used to access this submatrix (one based).
	 * @param validValue actually the variable content and not a placeholder?
	 **************************************************************************/
	constructor(
		name: string = '',
		value: string = '',
		freeIndices: Array<number> = [],
		fixedIndices: Array<number> = [],
		validValue: boolean = true,
		type: string = ComplexDiagonalMatrix.TYPENAME
	)
	{
		super(name, value, freeIndices, fixedIndices, validValue, type);
	}


	//**************************************************************************
	public typename(): string { return `complex ${ComplexDiagonalMatrix.TYPENAME}`; }


	//**************************************************************************
	public createConcreteType(
		name: string,
		value: string,
		freeIndices: Array<number>,
		fixedIndices: Array<number>,
		validValue: boolean
	): ComplexDiagonalMatrix
	{
		return new ComplexDiagonalMatrix(name, value, freeIndices, fixedIndices, validValue);
	}
}
